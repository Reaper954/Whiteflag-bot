// index.js
// Production-ready Discord.js v14 bot for White Flag system using JSON storage.
//
// Features:
// - /setup posts rules + apply panel (button-based modal form)
// - Rules must be accepted before form can submit (role gate)
// - Two separate application forms:
//    • 25x PVP
//    • 100x PVP Chaos
// - On submit: pings admin role in admin channel with Approve/Deny buttons
// - Approve: starts 7-day timer (no Open Season ping on expiry)
// - Admin can end early via button -> cancels timer + pings Open Season role in announce channel
// - /rules shows rules
// - /whiteflags active shows all approved + active White Flags
// - Enforces: only 1 active White Flag per tribe (across both modes)
//
// Requirements: discord.js v14, Node 18+
// Env:
//   DISCORD_TOKEN   (required)
//   CLIENT_ID      (required)  - your application's client id
//   GUILD_ID       (recommended) - if set, registers commands to this guild instantly
//   DATA_DIR       (optional) defaults ./data
//
// Install: npm i discord.js dotenv
// Run: node index.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error("Missing CLIENT_ID in environment.");
  process.exit(1);
}

// -------------------- Storage --------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const REQUESTS_PATH = path.join(DATA_DIR, "requests.json");
const CLAIMS_PATH = path.join(DATA_DIR, "claims.json");

// Ensure data dir exists
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Simple JSON store helpers (atomic-ish writes) ----
function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

// -------------------- Global persisted config --------------------
/**
 * state = {
 *   guildId: string,
 *   rulesChannelId: string,
 *   applyChannelId: string,
 *   adminChannelId: string,
 *   announceChannelId: string,
 *   adminRoleId: string,
 *   openSeasonRoleId: string,
 *   rulesAcceptedRoleId: string, // must exist
 *   rulesMessageId: string,
 *   applyMessageId: string
 * }
 *
 * NOTE: This implementation is single-guild (one config). If you want multi-guild support,
 * store state per guildId.
 */
let state = readJson(STATE_PATH, {
  guildId: null,
  rulesChannelId: null,
  applyChannelId: null,
  adminChannelId: null,
  announceChannelId: null,
  adminRoleId: null,
  openSeasonRoleId: null,
  rulesAcceptedRoleId: null,
  rulesMessageId: null,
  applyMessageId: null,
});

// requests = { [requestId]: { ... } }
let requests = readJson(REQUESTS_PATH, {});
let claims = readJson(CLAIMS_PATH, {});


// Active timers in memory: requestId -> timeout
const activeTimeouts = new Map();
// Active bounty timers in memory: requestId -> timeout
const activeBountyTimeouts = new Map();
// Active warning timers (24h prior): requestId -> timeout
const activeWfAlertTimeouts = new Map();
const activeBountyAlertTimeouts = new Map();

// -------------------- Constants for custom IDs --------------------
const CID = {
  RULES_ACCEPT: "wf_rules_accept",

  APPLY_OPEN_25: "wf_apply_open_25",
  APPLY_OPEN_100: "wf_apply_open_100",

  APPLY_MODAL_25: "wf_apply_modal_25",
  APPLY_MODAL_100: "wf_apply_modal_100",

  ADMIN_APPROVE_PREFIX: "wf_admin_approve:", // + requestId
  ADMIN_DENY_PREFIX: "wf_admin_deny:", // + requestId
  ADMIN_END_EARLY_PREFIX: "wf_admin_end:", // + requestId
};

// 7 days in ms
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// 1 week in ms
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BOUNTY_REWARD = "2,000 tokens";

// -------------------- Expiration alert test mode --------------------
// Set ALERT_TEST_MINUTES (e.g. 2) to send a quick test alert after approvals/bounties, and on startup for active records.
// Test alerts do NOT consume the real 24-hour warning (they use separate flags on the record).
const ALERT_TEST_MINUTES = Number(process.env.ALERT_TEST_MINUTES || 0);
const ALERT_TEST_MS = Number.isFinite(ALERT_TEST_MINUTES) && ALERT_TEST_MINUTES > 0 ? ALERT_TEST_MINUTES * 60 * 1000 : 0;
function isTestMode() {
  return Number.isFinite(ALERT_TEST_MINUTES) && ALERT_TEST_MINUTES > 0;
}
if (isTestMode()) {
  console.log(`🧪 ALERT TEST MODE enabled: ${ALERT_TEST_MINUTES} minute(s)`);
}

async function maybeSendTestAlert({ kind, requestId, req, realWarnAt }) {
  if (!isTestMode()) return;
  if (!requestId || !req) return;

  const flagKey = kind === "whiteflag" ? "wfTestWarnedAt" : "bountyTestWarnedAt";
  if (req[flagKey]) return;

  setTimeout(async () => {
    try {
      requests = readJson(REQUESTS_PATH, {});
      const r = requests[requestId];
      if (!r) return;
      if (r[flagKey]) return;

      const now = Date.now();
      if (kind === "whiteflag") {
        if (!isApprovedAndActive(r, now)) return;
      } else {
        if (!hasActiveBounty(r, now)) return;
      }

      r[flagKey] = now;
      requests[requestId] = r;
      persist();

      const guild = await safeFetchGuild(bot);
      if (!guild) return;
      const adminCh = await safeFetchChannel(guild, state.adminChannelId);
      if (!adminCh || !isTextChannel(adminCh)) return;

      const ping = state.adminRoleId ? `<@&${state.adminRoleId}> ` : "";
      const label = kind === "whiteflag" ? "WHITE FLAG" : "BOUNTY";
      const endsAt = kind === "whiteflag" ? (r.approvedAt ? r.approvedAt + SEVEN_DAYS_MS : null) : (r.bounty?.endsAt ?? null);

      await adminCh.send(
        `${ping}🧪 **[TEST MODE] ** — ${label} warning test for **${escapeMd(
          r.tribeName
        )}** (ID: \`${r.id}\`).\n` +
          `Real 24h warning would be at ${realWarnAt ? fmtDiscordRelativeTime(realWarnAt) : "N/A"}; expires ${endsAt ? fmtDiscordRelativeTime(endsAt) : "N/A"}.`
      );
    } catch {
      // ignore
    }
  }, ALERT_TEST_MS);
}

// -------------------- Helpers --------------------
function persist() {
  writeJson(STATE_PATH, state);
  writeJson(REQUESTS_PATH, requests);
}

function escapeMd(str) {
  if (!str) return "";
  return String(str).replace(/([*_`~|>])/g, "\\\\$1");
}

function isTextChannel(ch) {
  return (
    ch &&
    (ch.type === ChannelType.GuildText ||
      ch.type === ChannelType.GuildAnnouncement ||
      ch.type === ChannelType.PublicThread ||
      ch.type === ChannelType.PrivateThread)
  );
}

function newRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newClaimId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function persistClaims() {
  writeJson(CLAIMS_PATH, claims);
}

function findActiveBountyByTribe(tribeName) {
  const key = normalizeTribeName(tribeName);
  const now = Date.now();
  const active = Object.values(requests).find(
    (r) => normalizeTribeName(r?.tribeName) === key && hasActiveBounty(r, now)
  );
  return active || null;
}


function normalizeTribeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\\s+/g, " ");
}

function isApprovedAndActive(req, now = Date.now()) {
  return (
    req &&
    req.status === "approved" &&
    typeof req.approvedAt === "number" &&
    req.approvedAt + SEVEN_DAYS_MS > now
  );
}

function getPendingRequestForUser(userId) {
  for (const r of Object.values(requests)) {
    if (r?.requestedBy === userId && r?.status === "pending") return r;
  }
  return null;
}

function getActiveApprovedForTribe(tribeName, excludeId = null) {
  const key = normalizeTribeName(tribeName);
  const now = Date.now();
  for (const r of Object.values(requests)) {
    if (excludeId && r?.id === excludeId) continue;
    if (normalizeTribeName(r?.tribeName) !== key) continue;
    if (isApprovedAndActive(r, now)) return r;
  }
  return null;
}


function getActiveBountyForTribe(tribeName, excludeId = null) {
  const key = normalizeTribeName(tribeName);
  const now = Date.now();
  for (const r of Object.values(requests)) {
    if (excludeId && r?.id === excludeId) continue;
    if (normalizeTribeName(r?.tribeName) !== key) continue;
    if (hasActiveBounty(r, now)) return r;
  }
  return null;
}

async function ensureRulesAcceptedRole(guild) {
  // If state already has role id and it exists, use it
  if (state.rulesAcceptedRoleId) {
    const existing = await guild.roles.fetch(state.rulesAcceptedRoleId).catch(() => null);
    if (existing) return existing;
    state.rulesAcceptedRoleId = null;
  }

  // Ensure roles are fetched so we don't create duplicates due to cache misses
  await guild.roles.fetch().catch(() => null);

  // Try find by name (case-insensitive)
  const found = guild.roles.cache.find((r) => r.name.toLowerCase() === "rules accepted");
  if (found) {
    state.rulesAcceptedRoleId = found.id;
    persist();
    return found;
  }

  // Create role
  const created = await guild.roles.create({
    name: "Rules Accepted",
    mentionable: false,
    reason: "White Flag bot: role gate for rules acceptance",
  });
  state.rulesAcceptedRoleId = created.id;
  persist();
  return created;
}

async function safeFetchGuild(client) {
  if (!state.guildId) return null;
  return client.guilds.fetch(state.guildId).catch(() => null);
}

async function safeFetchChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  return guild.channels.fetch(channelId).catch(() => null);
}

function fmtDiscordRelativeTime(msEpoch) {
  const seconds = Math.floor(msEpoch / 1000);
  return `<t:${seconds}:R>`;
}

// -------------------- Timer lifecycle --------------------
function scheduleExpiry(requestId) {
  const req = requests[requestId];
  if (!req || req.status !== "approved" || !req.approvedAt) return;

  // Clear existing
  const existing = activeTimeouts.get(requestId);
  if (existing) clearTimeout(existing);

  const now = Date.now();
  const endsAt = req.approvedAt + SEVEN_DAYS_MS;
  const delay = Math.max(0, endsAt - now);

  const t = setTimeout(async () => {
    try {
      // Re-read latest in case of changes
      requests = readJson(REQUESTS_PATH, {});
      const r = requests[requestId];
      if (!r) return;
      if (r.status !== "approved") return; // denied/ended already

      r.status = "expired";
      r.expiredAt = Date.now();
      requests[requestId] = r;
      persist();

      // Post expiry message in admin channel (no role ping)
      const guild = await safeFetchGuild(bot);
      if (!guild) return;

      const adminCh = await safeFetchChannel(guild, state.adminChannelId);
      if (adminCh && isTextChannel(adminCh)) {
        await adminCh.send(
          `⏳ PROTECTION EXPIRED — White Flag ended for **${escapeMd(r.tribeName)}** (IGN: **${escapeMd(
            r.ign
          )}**, Server: **${escapeMd(r.serverType || r.cluster || "N/A")}**).`
        );
      }
    } finally {
      activeTimeouts.delete(requestId);
    }
  }, delay);

  activeTimeouts.set(requestId, t);
}
// -------------------- Bounty lifecycle (1 week) --------------------
function hasActiveBounty(req, now = Date.now()) {
  return (
    req &&
    req.bounty &&
    req.bounty.active === true &&
    typeof req.bounty.endsAt === "number" &&
    req.bounty.endsAt > now
  );
}

function scheduleBountyExpiry(requestId) {
  const req = requests[requestId];
  if (!req || !hasActiveBounty(req)) return;

  const existing = activeBountyTimeouts.get(requestId);
  if (existing) clearTimeout(existing);

  const now = Date.now();
  const delay = Math.max(0, req.bounty.endsAt - now);

  const t = setTimeout(async () => {
    try {
      requests = readJson(REQUESTS_PATH, {});
      const r = requests[requestId];
      if (!r || !r.bounty) return;

      const now2 = Date.now();
      if (!(r.bounty.active && typeof r.bounty.endsAt === "number" && r.bounty.endsAt <= now2)) return;

      r.bounty.active = false;
      r.bounty.expiredAt = now2;
      requests[requestId] = r;
      persist();

      const guild = await safeFetchGuild(bot);
      if (!guild) return;

      const announceCh = await safeFetchChannel(guild, state.announceChannelId);
      if (announceCh && isTextChannel(announceCh)) {
        await announceCh.send(
          `🏁 **BOUNTY CLOSED** — Target cleared for **${escapeMd(r.tribeName)}** (IGN: **${escapeMd(
            r.ign
          )}**, Server: **${escapeMd(r.serverType || r.cluster || "N/A")}**).`
        );
      }
    } finally {
      activeBountyTimeouts.delete(requestId);
    }
  }, delay);

  activeBountyTimeouts.set(requestId, t);
}

async function expireOverdueBountiesOnStartup() {
  try {
    requests = readJson(REQUESTS_PATH, {});
    const now = Date.now();

    let changed = false;
    for (const [id, r] of Object.entries(requests)) {
      if (r?.bounty?.active && typeof r.bounty.endsAt === "number" && r.bounty.endsAt <= now) {
        r.bounty.active = false;
        r.bounty.expiredAt = now;
        requests[id] = r;
        changed = true;
      }
    }
    if (changed) persist();
  } catch (_e) {
    console.error("Failed to expire overdue bounties:", _e);
  }
}


async function scheduleTestAlertsOnStartup() {
  const _atm = Number(process.env.ALERT_TEST_MINUTES || 0);
  if (!Number.isFinite(_atm) || _atm <= 0) return;
  try {
    requests = readJson(REQUESTS_PATH, {});
    const now = Date.now();
    for (const [id, r] of Object.entries(requests)) {
      if (isApprovedAndActive(r, now)) {
        const endsAt = r.approvedAt ? r.approvedAt + SEVEN_DAYS_MS : null;
        const warnAt = endsAt ? endsAt - 24 * 60 * 60 * 1000 : null;
        maybeSendTestAlert({ kind: "whiteflag", requestId: id, req: r, realWarnAt: warnAt });
      }
      if (hasActiveBounty(r, now)) {
        const warnAt = r.bounty?.endsAt ? r.bounty.endsAt - 24 * 60 * 60 * 1000 : null;
        maybeSendTestAlert({ kind: "bounty", requestId: id, req: r, realWarnAt: warnAt });
      }
    }
  } catch {
      // ignore
    }
}

// -------------------- Expiration warnings (24h prior) --------------------
function isApprovedAndActiveWithEnds(req, now = Date.now()) {
  if (!req || req.status !== "approved" || !req.approvedAt) return null;
  const endsAt = req.approvedAt + SEVEN_DAYS_MS;
  if (endsAt <= now) return null;
  return endsAt;
}

function scheduleWhiteFlagExpiryWarning(requestId) {
  const req = requests[requestId];
  const now = Date.now();
  const endsAt = isApprovedAndActiveWithEnds(req, now);
  if (!endsAt) return;

  const warnAt = endsAt - ONE_DAY_MS;
  if (req.wfWarnedAt) return; // already warned

  // Clear existing
  const existing = activeWfAlertTimeouts.get(requestId);
  if (existing) clearTimeout(existing);

  const delay = Math.max(0, warnAt - now);

  const t = setTimeout(async () => {
    try {
      requests = readJson(REQUESTS_PATH, {});
      const r = requests[requestId];
      const now2 = Date.now();
      const endsAt2 = isApprovedAndActiveWithEnds(r, now2);
      if (!endsAt2) return;

      const warnAt2 = endsAt2 - ONE_DAY_MS;
      if (r.wfWarnedAt) return;
      if (now2 < warnAt2 || now2 >= endsAt2) return;

      r.wfWarnedAt = now2;
      requests[requestId] = r;
      persist();

      const guild = await safeFetchGuild(bot);
      if (!guild || !state.adminChannelId) return;

      const adminCh = await safeFetchChannel(guild, state.adminChannelId);
      if (!adminCh || !isTextChannel(adminCh)) return;

      const ping = state.adminRoleId ? `<@&${state.adminRoleId}> ` : "";
      await adminCh.send(
        `${ping}⚠️ **** — White Flag for **${escapeMd(r.tribeName)}** expires in **24 hours**. ` +
          `Ends ${fmtDiscordRelativeTime(endsAt2)} (ID: \`${r.id}\`).`
      );
    } catch (_e) {
      console.error("White Flag warning failed:", _e);
    } finally {
      activeWfAlertTimeouts.delete(requestId);
    }
  }, delay);

  activeWfAlertTimeouts.set(requestId, t);
  // Optional test-mode alert
  maybeSendTestAlert({ kind: "whiteflag", requestId, req, realWarnAt: warnAt });

}

function scheduleBountyExpiryWarning(requestId) {
  const req = requests[requestId];
  const now = Date.now();
  if (!hasActiveBounty(req, now)) return;

  const endsAt = req.bounty.endsAt;
  const warnAt = endsAt - ONE_DAY_MS;
  if (req.bountyWarnedAt) return;

  const existing = activeBountyAlertTimeouts.get(requestId);
  if (existing) clearTimeout(existing);

  const delay = Math.max(0, warnAt - now);

  const t = setTimeout(async () => {
    try {
      requests = readJson(REQUESTS_PATH, {});
      const r = requests[requestId];
      const now2 = Date.now();
      if (!hasActiveBounty(r, now2)) return;

      const endsAt2 = r.bounty.endsAt;
      const warnAt2 = endsAt2 - ONE_DAY_MS;
      if (r.bountyWarnedAt) return;
      if (now2 < warnAt2 || now2 >= endsAt2) return;

      r.bountyWarnedAt = now2;
      requests[requestId] = r;
      persist();

      const guild = await safeFetchGuild(bot);
      if (!guild || !state.adminChannelId) return;

      const adminCh = await safeFetchChannel(guild, state.adminChannelId);
      if (!adminCh || !isTextChannel(adminCh)) return;

      const ping = state.adminRoleId ? `<@&${state.adminRoleId}> ` : "";
      await adminCh.send(
        `${ping}⚠️ **** — Bounty on **${escapeMd(r.tribeName)}** expires in **24 hours**. ` +
          `Ends ${fmtDiscordRelativeTime(endsAt2)} (ID: \`${r.id}\`).`
      );
    } catch (_e) {
      console.error("Bounty warning failed:", _e);
    } finally {
      activeBountyAlertTimeouts.delete(requestId);
    }
  }, delay);

  activeBountyAlertTimeouts.set(requestId, t);
  // Optional test-mode alert
  maybeSendTestAlert({ kind: "bounty", requestId, req, realWarnAt: warnAt });

}



async function expireOverdueApprovalsOnStartup() {
  // If bot was down past the expiry time, mark them expired so they don't stay "approved" forever.
  try {
    requests = readJson(REQUESTS_PATH, {});
    const now = Date.now();

    const guild = await safeFetchGuild(bot);
    const adminCh = guild ? await safeFetchChannel(guild, state.adminChannelId) : null;

    let changed = false;
    for (const [id, r] of Object.entries(requests)) {
      if (r?.status === "approved" && r?.approvedAt) {
        const endsAt = r.approvedAt + SEVEN_DAYS_MS;
        if (endsAt <= now) {
          r.status = "expired";
          r.expiredAt = now;
          requests[id] = r;
          changed = true;

          if (adminCh && isTextChannel(adminCh)) {
            await adminCh.send(
              `⏳ PROTECTION EXPIRED (offline) — White Flag ended for **${escapeMd(
                r.tribeName
              )}** (IGN: **${escapeMd(r.ign)}**, Server: **${escapeMd(
                r.serverType || r.cluster || "N/A"
              )}**).`
            );
          }
        }
      }
    }
    if (changed) persist();
  } catch (_e) {
    console.error("Failed to expire overdue approvals:", _e);
  }
}

// -------------------- Rules / Apply panels --------------------
function buildRulesEmbed() {
  return new EmbedBuilder()
    .setTitle("🛡️White Flag Protocol🛡️")
    .setDescription(
      [
        "** PROTOCOL:** This system grants temporary protection to new tribes. Abuse will trigger enforcement action and will result in an active bounty.",
        "",
        "**Eligibility & Duration**",
        "• White Flag is intended for **new tribes only**.",
        "• Protection lasts **7 days from approval**.",
        "• Admins will remove the White Flag early if rules are broken.",
        "",
        "**While White Flag is Active**",
        "• **YOU CAN NOT RAID OTHER TRIBES.**",
        "• Build, farm, tame, and establish your base.",
        "• You can do PvP in the open as long as you are not raiding their base or scouting a base.",
        "",
        "**Protections Granted**",
        "• Your tribe should not be raided while White Flag is active.",
        "• Harassment or targeting White Flag tribes is not allowed.",
        "",
        "**Violations**",
        "• Raiding while under White Flag = **immediate removal**.",
        "• Abuse of protection (scouting for raids, feeding intel, etc.) = **removal**.",
        "• Admin discretion may apply additional penalties.",
        "• If you break the rules, your flag will be removed, your tribe will be announced as **OPEN SEASON**, and a bounty will be placed.",
        "",
        "**After Expiration**",
        "Once your White Flag expires your tribe is fully open to normal PvP rules.",
      ].join("\n")
    );
}

function buildRulesRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CID.RULES_ACCEPT)
      .setLabel("✅ I Agree & Understand")
      .setStyle(ButtonStyle.Success)
  );
}

function buildApplyEmbed() {
  return new EmbedBuilder()
    .setTitle("🛡️White Flag Applications🛡️")
    .setDescription(
      [
        "Before applying, you must read and accept the rules.",
        "",
        "Choose the correct server and submit your request:",
        "• **25x PVP**",
        "• **100x PVP Chaos**",
        "",
        "**Important:** Only **1 White Flag per tribe.**",
      ].join("\n")
    );
}

function buildApplyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CID.APPLY_OPEN_25)
      .setLabel("🏳️ Apply — 25x PVP")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CID.APPLY_OPEN_100)
      .setLabel("🏳️ Apply — 100x PVP Chaos")
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildAdminReviewEmbed(req) {
  const endsAt = req?.approvedAt ? req.approvedAt + SEVEN_DAYS_MS : null;

  const embed = new EmbedBuilder()
    .setTitle("🛡️Application Received🛡️")
    .addFields(
      { name: "Server", value: escapeMd(req.serverType || req.cluster || "N/A"), inline: true },
      { name: "IGN", value: escapeMd(req.ign), inline: true },
      { name: "Tribe Name", value: escapeMd(req.tribeName), inline: true },
      { name: "Map", value: escapeMd(req.map), inline: true },
      { name: "Requested By", value: `<@${req.requestedBy}>`, inline: false }
    )
    .setFooter({ text: `Request ID: ${req.id}` });

  if (endsAt) {
    embed.addFields({ name: "Ends", value: fmtDiscordRelativeTime(endsAt), inline: true });
  }

  return embed;
}

// -------------------- Slash command registration --------------------
async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("setup")
      .setDescription("Post rules + apply panels and configure channels/roles for White Flag.")
      .addChannelOption((opt) =>
        opt
          .setName("rules_channel")
          .setDescription("Channel to post the rules panel")
          .setRequired(true)
      )
      .addChannelOption((opt) =>
        opt
          .setName("apply_channel")
          .setDescription("Channel to post the application panel")
          .setRequired(true)
      )
      .addChannelOption((opt) =>
        opt
          .setName("admin_channel")
          .setDescription("Channel where admin reviews go")
          .setRequired(true)
      )
      .addChannelOption((opt) =>
        opt
          .setName("announce_channel")
          .setDescription("Channel to announce OPEN SEASON pings")
          .setRequired(true)
      )
      .addRoleOption((opt) =>
        opt
          .setName("admin_role")
          .setDescription("Role to ping for new applications")
          .setRequired(true)
      )
      .addRoleOption((opt) =>
        opt
          .setName("open_season_role")
          .setDescription("Role to ping when ending early (OPEN SEASON)")
          .setRequired(true)
      )
      .addChannelOption((opt) =>
        opt
          .setName("bounty_channel")
          .setDescription("Channel to announce bounties")
          .setRequired(false)
      )
,

    new SlashCommandBuilder()
      .setName("rules")
      .setDescription("Show the White Flag rules (ephemeral)."),

    new SlashCommandBuilder()
      .setName("whiteflags")
      .setDescription("White Flag utilities.")
      .addSubcommand((sc) =>
        sc.setName("active").setDescription("Show all approved and active White Flags.")
      ),

    new SlashCommandBuilder()
      .setName("bounty")
      .setDescription("Create, remove, or claim bounties.")
      .addSubcommand((sc) =>
        sc
          .setName("add")
          .setDescription("Add/refresh a bounty for a tribe (1 week).")
          .addStringOption((opt) =>
            opt.setName("tribe").setDescription("Tribe name").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("ign").setDescription("Bounty target IGN (optional)").setRequired(false)
          )
          .addStringOption((opt) =>
            opt.setName("server").setDescription("Server/Cluster (optional)").setRequired(false)
          )
          .addStringOption((opt) =>
            opt.setName("reason").setDescription("Reason (optional)").setRequired(false)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName("remove")
          .setDescription("Remove an active bounty by tribe or by ID.")
          .addStringOption((opt) =>
            opt.setName("tribe").setDescription("Tribe name").setRequired(false)
          )
          .addStringOption((opt) =>
            opt.setName("id").setDescription("Bounty record ID").setRequired(false)
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName("claim")
          .setDescription("Submit a bounty claim (creates an admin ticket).")
          .addStringOption((opt) =>
            opt.setName("tribe").setDescription("Bounty target tribe").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("ign").setDescription("Your IGN").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("bounty_ign").setDescription("Bounty target IGN").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("proof").setDescription("Submit proof in a ticket)").setRequired(true)
          )
      ),

    new SlashCommandBuilder()
      .setName("bounties")
      .setDescription("Bounty utilities.")
      .addSubcommand((sc) =>
        sc.setName("active").setDescription("Show all active bounties.")
      ),

    new SlashCommandBuilder()
      .setName("tribe")
      .setDescription("Admin tribe utilities.")
      .addSubcommand((sc) =>
        sc
          .setName("endwhiteflag")
          .setDescription("End a tribe's White Flag early (OPEN SEASON + bounty).")
          .addStringOption((opt) =>
            opt.setName("id").setDescription("White Flag record ID").setRequired(true)
          )
      ),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`✅ Registered slash commands to guild ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("✅ Registered global slash commands (can take up to ~1 hour to appear).");
    }
  } catch (_e) {
    console.error("Failed to register slash commands:", _e);
  }
}



// -------------------- Discord client --------------------
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

bot.once("clientReady", async () => {
  console.log(`✅ Logged in as ${bot.user.tag}`);

  // Register slash commands (safe to do on startup)
  await registerSlashCommands();

  // Expire overdue approvals (if bot was offline)
  await expireOverdueApprovalsOnStartup();
  await expireOverdueBountiesOnStartup();
  await scheduleTestAlertsOnStartup();

  // Re-schedule timers after restart
  try {
    requests = readJson(REQUESTS_PATH, {});
    const now = Date.now();
    for (const [id, r] of Object.entries(requests)) {
      if (isApprovedAndActive(r, now)) {
        scheduleExpiry(id);
        scheduleWhiteFlagExpiryWarning(id);
      }
      if (hasActiveBounty(r, now)) {
        scheduleBountyExpiry(id);
        scheduleBountyExpiryWarning(id);
        maybeSendTestAlert({ kind: "bounty", requestId: id, req: r, realWarnAt: null });
      }
    }
  } catch (_e) {
    console.error("Failed to reschedule timers:", _e);
  }
});

bot.on("interactionCreate", async (interaction) => {
  try {
    // -------------------- Slash commands --------------------
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "setup") {
        // Admin check (server perms)
        if (
          !interaction.memberPermissions ||
          !interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)
        ) {
          return interaction.reply({ content: "Admins only.", flags: 64});
        }

        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: "Guild only.", flags: 64});

        // Resolve options (all required by command definition)
        const rulesChannel = interaction.options.getChannel("rules_channel");
        const applyChannel = interaction.options.getChannel("apply_channel");
        const adminChannel = interaction.options.getChannel("admin_channel");
        const announceChannel = interaction.options.getChannel("announce_channel");
        const adminRole = interaction.options.getRole("admin_role");
        const openSeasonRole = interaction.options.getRole("open_season_role");

        if (![rulesChannel, applyChannel, adminChannel, announceChannel].every(isTextChannel)) {
          return interaction.reply({
            content: "All channels must be text channels.",
            flags: 64});
        }
        if (!adminRole || !openSeasonRole) {
          return interaction.reply({
            content: "Admin role and Open Season role are required.",
            flags: 64});
        }

        // Ensure role for rules gate exists
        const rulesAcceptedRole = await ensureRulesAcceptedRole(guild);

        // Persist config
        state.guildId = guild.id;
        state.rulesChannelId = rulesChannel.id;
        state.applyChannelId = applyChannel.id;
        state.adminChannelId = adminChannel.id;
        state.announceChannelId = announceChannel.id;
        state.adminRoleId = adminRole.id;
        state.openSeasonRoleId = openSeasonRole.id;
        state.rulesAcceptedRoleId = rulesAcceptedRole.id;

        // Post panels
        const rulesMsg = await rulesChannel.send({
          embeds: [buildRulesEmbed()],
          components: [buildRulesRow()],
        });

        const applyMsg = await applyChannel.send({
          embeds: [buildApplyEmbed()],
          components: [buildApplyRow()],
        });

        state.rulesMessageId = rulesMsg.id;
        state.applyMessageId = applyMsg.id;
        persist();

        return interaction.reply({
          content:
            `🛡️Setup complete.🛡️\n` +
            `• Rules panel: <#${rulesChannel.id}>\n` +
            `• Apply panel: <#${applyChannel.id}>\n` +
            `• Admin review: <#${adminChannel.id}> (ping <@&${adminRole.id}>)\n` +
            `• Open Season announcements: <#${announceChannel.id}> (ping <@&${openSeasonRole.id}>)\n` +
            `• Rules gate role: <@&${rulesAcceptedRole.id}>`,
          flags: 64,
        });
      }

      if (interaction.commandName === "rules") {
        return interaction.reply({
          embeds: [buildRulesEmbed()],
          components: [buildRulesRow()],
          flags: 64});
      }

      if (interaction.commandName === "whiteflags" && interaction.options.getSubcommand() === "active") {
        // Admin-only (admin role or Administrator)
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: "Guild only.", flags: 64});

        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        const isAdminPerm =
          member?.permissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
        const hasAdminRole = state.adminRoleId ? member?.roles?.cache?.has(state.adminRoleId) : false;

        if (!isAdminPerm && !hasAdminRole) {
          const sub = interaction.options.getSubcommand();
          if (sub !== "claim") {
            return interaction.reply({ content: "Admins only.", flags: 64});
          }
        }
requests = readJson(REQUESTS_PATH, {});
        const now = Date.now();
        const active = Object.values(requests).filter((r) => isApprovedAndActive(r, now));

        if (active.length === 0) {
          return interaction.reply({ content: "No active White Flags right now.", flags: 64});
        }

        // Sort by end time soonest
        active.sort((a, b) => (a.approvedAt + SEVEN_DAYS_MS) - (b.approvedAt + SEVEN_DAYS_MS));

        const lines = active.map((r) => {
          const endsAt = r.approvedAt + SEVEN_DAYS_MS;
          const server = escapeMd(r.serverType || r.cluster || "N/A");
          return `• **${escapeMd(r.tribeName)}** — IGN: **${escapeMd(r.ign)}** — Server: **${server}** — Ends ${fmtDiscordRelativeTime(endsAt)} (ID: \`${r.id}\`)`;
        });

        const embed = new EmbedBuilder()
          .setTitle(`Active White Flags (${active.length})`)
          .setDescription(lines.join("\n").slice(0, 3900)); // keep under embed limits

        return interaction.reply({ embeds: [embed], flags: 64});
      }
    }
      if (interaction.commandName === "bounties" && interaction.options.getSubcommand() === "active") {
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: "Guild only.", flags: 64});

        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        const isAdminPerm =
          member?.permissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
        const hasAdminRole = state.adminRoleId ? member?.roles?.cache?.has(state.adminRoleId) : false;

        if (!isAdminPerm && !hasAdminRole) {
          return interaction.reply({ content: "Admins only.", flags: 64});
        }

        requests = readJson(REQUESTS_PATH, {});
        const now = Date.now();
        const active = Object.values(requests).filter((r) => hasActiveBounty(r, now));

        if (active.length === 0) {
          return interaction.reply({ content: "No active bounties right now.", flags: 64});
        }

        active.sort((a, b) => a.bounty.endsAt - b.bounty.endsAt);

        const lines = active.map((r) => {
          const server = escapeMd(r.serverType || r.cluster || "N/A");
          return `• **${escapeMd(r.tribeName)}** — IGN: **${escapeMd(r.ign)}** — Server: **${server}** — Ends ${fmtDiscordRelativeTime(r.bounty.endsAt)} (ID: \`${r.id}\`)`;
        });

        const embed = new EmbedBuilder()
          .setTitle(`Active Bounties (${active.length})`)
          .setDescription(lines.join("\n").slice(0, 3900));

        return interaction.reply({ embeds: [embed], flags: 64});
      }

      // -------------------- Bounty control --------------------
      if (interaction.commandName === "bounty") {
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: "Guild only.", flags: 64});

        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        const isAdminPerm =
          member?.permissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
        const hasAdminRole = state.adminRoleId ? member?.roles?.cache?.has(state.adminRoleId) : false;

        if (!isAdminPerm && !hasAdminRole) {
          return interaction.reply({ content: "Admins only.", flags: 64});
        }

        const sub = interaction.options.getSubcommand();

        if (sub === "claim") {
          const tribe = interaction.options.getString("tribe", true).trim();
          const proof = interaction.options.getString("proof", true).trim();
          const notes = (interaction.options.getString("notes") || "").trim();

          requests = readJson(REQUESTS_PATH, {});
          claims = readJson(CLAIMS_PATH, {});

          const target = findActiveBountyByTribe(tribe);
          if (!target) {
            return interaction.reply({
              content: "No active bounty found for that tribe.",
              flags: 64});
          }

          const claimId = newClaimId();
          const now = Date.now();
          const claim = {
            id: claimId,
            bountyRecordId: target.id,
            tribeName: target.tribeName,
            reward: BOUNTY_REWARD,
            submittedBy: interaction.user.id,
            submittedAt: now,
            proof,
            notes,
            status: "pending",
          };

          claims[claimId] = claim;
          persistClaims();

          const adminCh = await safeFetchChannel(guild, state.adminChannelId);
          if (adminCh && isTextChannel(adminCh)) {
            const embed = new EmbedBuilder()
              .setTitle("🎯 Bounty Claim Submitted")
              .setDescription(
                `Target: **${escapeMd(target.tribeName)}**\n` +
                  `Reward: **${BOUNTY_REWARD}**\n` +
                  `Submitted by: <@${interaction.user.id}>\n` +
                  `Proof: ${proof}` +
                  (notes ? `\nNotes: ${escapeMd(notes)}` : "") +
                  `\nRecord ID: \`${target.id}\`\nClaim ID: \`${claimId}\``
              );

            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`bounty_claim_approve:${claimId}`)
                .setLabel("Approve")
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`bounty_claim_deny:${claimId}`)
                .setLabel("Deny")
                .setStyle(ButtonStyle.Danger)
            );

            await adminCh.send({ embeds: [embed], components: [row] });
          }

          return interaction.reply({
            content:
              "✅ Claim submitted for admin review. If approved, the bounty will be closed and the reward announced.",
            flags: 64});
        }

        requests = readJson(REQUESTS_PATH, {});

        if (sub === "add") {
          const tribe = interaction.options.getString("tribe", true).trim();
          const ign = (interaction.options.getString("ign") || "").trim();
          const server = (interaction.options.getString("server") || "").trim();
          const reason = (interaction.options.getString("reason") || "").trim();

          const existing = getActiveBountyForTribe(tribe);
          const now = Date.now();

          if (existing) {
            existing.bounty = {
              ...existing.bounty,
              active: true,
              startedAt: existing.bounty.startedAt || now,
              endsAt: now + ONE_WEEK_MS,
              startedBy: existing.bounty.startedBy || interaction.user.id,
              refreshedAt: now,
              refreshedBy: interaction.user.id,
              reason: reason || existing.bounty.reason || "Manual bounty refresh.",
            };
            if (ign) existing.ign = ign;
            if (server) existing.serverType = server;

            requests[existing.id] = existing;
            persist();

            scheduleBountyExpiry(existing.id);
            scheduleBountyExpiryWarning(existing.id);
            maybeSendTestAlert({ kind: "bounty", requestId: existing.id, req: existing, realWarnAt: null });

            return interaction.reply({
              content:
                `🛡️Bounty refreshed for **${escapeMd(tribe)}**. Ends ${fmtDiscordRelativeTime(existing.bounty.endsAt)} (ID: \`${existing.id}\`).`,
              flags: 64,
            });
          }

          const id = newRequestId();
          const record = {
            id,
            status: "bounty_only",
            tribeName: tribe,
            ign: ign || "N/A",
            serverType: server || "N/A",
            map: "N/A",
            requestedBy: interaction.user.id,
            requestedAt: now,
            bounty: {
              active: true,
              startedAt: now,
              endsAt: now + ONE_WEEK_MS,
              startedBy: interaction.user.id,
              reason: reason || "Manual bounty created.",
            },
          };

          requests[id] = record;
          persist();
          scheduleBountyExpiry(id);
          scheduleBountyExpiryWarning(id);
        maybeSendTestAlert({ kind: "bounty", requestId: id, req: record, realWarnAt: null });

          const bountyCh = await safeFetchChannel(
              interaction.guild,
            state.bountyAnnounceChannelId || state.announceChannelId || state.adminChannelId
          );
          if (bountyCh && isTextChannel(bountyCh)) {
            const claimRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`bounty_claim_open:${record.id}`)
                .setLabel("Claim Bounty")
                .setStyle(ButtonStyle.Primary)
            );

            const bountyMsg = await bountyCh.send({
              content:
                `🎯 **BOUNTY ISSUED** — **${escapeMd(record.tribeName)}** ` +
                `(IGN: **${escapeMd(record.ign)}**, Server: **${escapeMd(record.serverType)}**) — ` +
                `Reward: **${BOUNTY_REWARD}** — ends ${fmtDiscordRelativeTime(record.bounty.endsAt)}.`,
              components: [claimRow],
            });
            // Store the announcement message so we can disable it when claimed/removed
              req.bounty.announceChannelId = bountyCh.id;
              req.bounty.announceMessageId = bountyMsg.id;
              requests[requestId] = req;
              persist();
}

          return interaction.reply({
            content:
              `🛡️Bounty issued for **${escapeMd(record.tribeName)}**. Ends ${fmtDiscordRelativeTime(record.bounty.endsAt)} (ID: \`${id}\`).`,
            flags: 64,
          });
        }

        if (sub === "remove") {
          const tribe = (interaction.options.getString("tribe") || "").trim();
          const id = (interaction.options.getString("id") || "").trim();

          if (!tribe && !id) {
            return interaction.reply({
              content: "Provide either **tribe** or **id**.",
              flags: 64});
          }

          let target = null;
          if (id) target = requests[id] || null;
          if (!target && tribe) target = getActiveBountyForTribe(tribe);

          if (!target || !target.bounty || !target.bounty.active) {
            return interaction.reply({ content: "No active bounty found for that input.", flags: 64});
          }

          const t = activeBountyTimeouts.get(target.id);
          if (t) clearTimeout(t);
          activeBountyTimeouts.delete(target.id);

          target.bounty.active = false;
          target.bounty.removedAt = Date.now();
          target.bounty.removedBy = interaction.user.id;


// Disable the bounty announcement button (if stored)
try {
  const chId = target.bounty.announceChannelId;
  const msgId = target.bounty.announceMessageId;
  if (chId && msgId) {
    const bountyCh = await guild.channels.fetch(chId).catch(() => null);
    if (bountyCh && isTextChannel(bountyCh)) {
      const msg = await bountyCh.messages.fetch(msgId).catch(() => null);
      if (msg) await msg.edit({ content: msg.content + "\n🛑 **CANCELED**", components: [] }).catch(() => null);
    }
  }
} catch {
  // ignore
}

          requests[target.id] = target;
          persist();

          const announceCh = await safeFetchChannel(guild, state.announceChannelId);
          if (announceCh && isTextChannel(announceCh)) {
            await announceCh.send(
              `🛑 **BOUNTY CANCELED** — **${escapeMd(target.tribeName)}** (ID: \`${target.id}\`).`
            );
          }

          return interaction.reply({
            content: `🛡️Bounty canceled for **${escapeMd(target.tribeName)}** (ID: \`${target.id}\`).`,
            flags: 64,
          });
        }
      }

      // -------------------- Tribe intelligence --------------------
      if (interaction.commandName === "tribe") {
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: "Guild only.", flags: 64});

        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        const isAdminPerm =
          member?.permissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
        const hasAdminRole = state.adminRoleId ? member?.roles?.cache?.has(state.adminRoleId) : false;

        if (!isAdminPerm && !hasAdminRole) {
          return interaction.reply({ content: "Admins only.", flags: 64});
        }

        const sub = interaction.options.getSubcommand();
        const tribe = interaction.options.getString("tribe", true).trim();

        requests = readJson(REQUESTS_PATH, {});
        const key = normalizeTribeName(tribe);
        const now = Date.now();

        const entries = Object.values(requests)
          .filter((r) => normalizeTribeName(r?.tribeName) === key)
          .sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));

        const activeWf = entries.find((r) => isApprovedAndActive(r, now)) || null;
        const activeB = entries.find((r) => hasActiveBounty(r, now)) || null;

        if (sub === "status") {
          const lines = [];

          if (activeWf) {
            lines.push(
              `🏳️ **White Flag:** ACTIVE — ends ${fmtDiscordRelativeTime(activeWf.approvedAt + SEVEN_DAYS_MS)} (ID: \`${activeWf.id}\`)`
            );
          } else {
            lines.push("🏳️ **White Flag:** none active");
          }

          if (activeB) {
            lines.push(
              `🎯 **Bounty:** ACTIVE — ends ${fmtDiscordRelativeTime(activeB.bounty.endsAt)} (ID: \`${activeB.id}\`)`
            );
          } else {
            lines.push("🎯 **Bounty:** none active");
          }

          const embed = new EmbedBuilder()
            .setTitle(`🛡️  — Tribe Status — ${escapeMd(tribe)}`)
            .setDescription(lines.join("\n"));

          return interaction.reply({ embeds: [embed], flags: 64});
        }

        if (sub === "history") {
          if (entries.length === 0) {
            return interaction.reply({ content: "No records found for that tribe.", flags: 64});
          }

          const recent = entries.slice(0, 10);
          const lines = recent.map((r) => {
            const server = escapeMd(r.serverType || r.cluster || "N/A");
            const status = escapeMd(r.status || "unknown");
            const when = r.requestedAt ? fmtDiscordRelativeTime(r.requestedAt) : "N/A";

            const wfPart =
              r.status === "approved" && r.approvedAt
                ? ` — WF ends ${fmtDiscordRelativeTime(r.approvedAt + SEVEN_DAYS_MS)}`
                : "";

            const bountyPart = r.bounty
              ? ` — Bounty ${r.bounty.active ? "ACTIVE" : "inactive"} (ends ${
                  r.bounty.endsAt ? fmtDiscordRelativeTime(r.bounty.endsAt) : "N/A"
                })`
              : "";

            return `• \`${r.id}\` — **${status}** — Server: **${server}** — requested ${when}${wfPart}${bountyPart}`;
          });

          const embed = new EmbedBuilder()
            .setTitle(`🛡️  — Tribe History — ${escapeMd(tribe)}`)
            .setDescription(lines.join("\n").slice(0, 3900));

          return interaction.reply({ embeds: [embed], flags: 64});
        }
      }


    // -------------------- Buttons --------------------
    if (interaction.isButton()) {
            // ---- Player: open bounty claim modal from announcement ----
      if (interaction.customId.startsWith("bounty_claim_open:")) {
        const [, recordId] = interaction.customId.split(":");
        requests = readJson(REQUESTS_PATH, {});
        const record = requests[recordId];
        const now = Date.now();
        if (!record || !hasActiveBounty(record, now)) {
          return interaction.reply({ content: "This bounty is no longer active.", flags: 64});
        }

        const modal = new ModalBuilder()
          .setCustomId(`bounty_claim_submit:${recordId}`)
          .setTitle("Bounty Claim");

        const ignInput = new TextInputBuilder()
          .setCustomId("ign")
          .setLabel("Your IGN")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const bountyIgnInput = new TextInputBuilder()
          .setCustomId("bounty_ign")
          .setLabel("Bounty Target IGN")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const proofInput = new TextInputBuilder()
          .setCustomId("proof")
          .setLabel("Proof link (clip/screenshot)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(ignInput),
          new ActionRowBuilder().addComponents(bountyIgnInput),
          new ActionRowBuilder().addComponents(proofInput)
        );

        return interaction.showModal(modal);
      }



// ---- Admin: approve/deny bounty claims ----
if (interaction.customId.startsWith("bounty_claim_approve:") || interaction.customId.startsWith("bounty_claim_deny:")) {
  if (!interaction.guild) return interaction.reply({ content: "Guild only.", flags: 64});

  // Enforce admin channel if configured
  if (state.adminChannelId && interaction.channelId !== state.adminChannelId) {
    return interaction.reply({ content: "Admin actions must be used in the admin review channel.", flags: 64});
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const isAdminPerm = member?.permissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
  const hasAdminRole = state.adminRoleId ? member?.roles?.cache?.has(state.adminRoleId) : false;

  if (!isAdminPerm && !hasAdminRole) {
    return interaction.reply({ content: "Admins only.", flags: 64});
  }

  const action = interaction.customId.split(":")[0]; // bounty_claim_approve / bounty_claim_deny
  const claimId = interaction.customId.split(":")[1];

  claims = readJson(CLAIMS_PATH, {});
  requests = readJson(REQUESTS_PATH, {});
  const claim = claims[claimId];

  if (!claim) {
    return interaction.reply({ content: "Claim not found (maybe already handled).", flags: 64});
  }
  if (claim.status && claim.status !== "pending") {
    return interaction.reply({ content: `Claim already **${claim.status}**.`, flags: 64 });
  }

  const record = requests[claim.bountyRecordId];

  if (action === "bounty_claim_deny") {
    claim.status = "denied";
    claim.deniedAt = Date.now();
    claim.deniedBy = interaction.user.id;
    claims[claimId] = claim;
    persistClaims();

    // Disable buttons on the claim message
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bounty_claim_deny:${claimId}`)
        .setLabel("Denied")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`bounty_claim_approve:${claimId}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );

    return interaction.update({
      content: interaction.message.content,
      embeds: interaction.message.embeds,
      components: [row],
    });
  }

  // Approve
  claim.status = "approved";
  claim.approvedAt = Date.now();
  claim.approvedBy = interaction.user.id;
  claims[claimId] = claim;
  persistClaims();

  // Close the bounty automatically
  if (record && record.bounty) {
    // Cancel timers
    const t1 = activeBountyTimeouts.get(record.id);
    if (t1) clearTimeout(t1);
    activeBountyTimeouts.delete(record.id);

    const t2 = activeBountyAlertTimeouts.get(record.id);
    if (t2) clearTimeout(t2);
    activeBountyAlertTimeouts.delete(record.id);

    record.bounty.active = false;
    record.bounty.claimedAt = Date.now();
    record.bounty.claimedBy = interaction.user.id;
    record.bounty.claimId = claimId;

    requests[record.id] = record;
    persist();

    // Remove/disable the "Claim Bounty" button on the bounty announcement (if we have it stored)
    try {
      const chId = record.bounty.announceChannelId;
      const msgId = record.bounty.announceMessageId;
      if (chId && msgId) {
        const bountyCh = await interaction.guild.channels.fetch(chId).catch(() => null);
        if (bountyCh && isTextChannel(bountyCh)) {
          const msg = await bountyCh.messages.fetch(msgId).catch(() => null);
          if (msg) {
            await msg.edit({
              content:
                msg.content +
                `\n✅ **CLAIMED** by <@${claim.submittedBy}> — approved by <@${interaction.user.id}>.`,
              components: [],
            }).catch(() => null);
          }
        }
      }
    } catch {
      // ignore
    }

    // Announce closure (no ping)
    const announceCh = await safeFetchChannel(interaction.guild, state.announceChannelId);
    if (announceCh && isTextChannel(announceCh)) {
      await announceCh.send(
        `🏁 **BOUNTY CLAIM APPROVED** — **${escapeMd(record.tribeName)}** bounty closed. ` +
        `Claimant: <@${claim.submittedBy}> — Reward: **${BOUNTY_REWARD}**.`
      );
    }
  }

  // Disable buttons on the claim message
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bounty_claim_deny:${claimId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`bounty_claim_approve:${claimId}`)
      .setLabel("Approved")
      .setStyle(ButtonStyle.Success)
      .setDisabled(true)
  );

  return interaction.update({
    content: interaction.message.content,
    embeds: interaction.message.embeds,
    components: [row],
  });
}

      // Rules accept
      if (interaction.customId === CID.RULES_ACCEPT) {
        if (!interaction.guild || !interaction.member) {
          return interaction.reply({ content: "Guild only.", flags: 64});
        }
        if (!state.rulesAcceptedRoleId) {
          return interaction.reply({
            content: "Bot not setup yet. Ask an admin to run /setup.",
            flags: 64});
        }

        const role = await interaction.guild.roles
          .fetch(state.rulesAcceptedRoleId)
          .catch(() => null);
        if (!role) {
          return interaction.reply({
            content: "Rules role missing. Ask an admin to rerun /setup.",
            flags: 64});
        }

        const member = await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null);
        if (!member) return interaction.reply({ content: "Could not fetch member.", flags: 64});

        if (member.roles.cache.has(role.id)) {
          return interaction.reply({
            content: "🛡️Rules already acknowledged. You may apply.🛡️",
            flags: 64});
        }

        await member.roles.add(role, "Accepted White Flag rules").catch(() => null);
        return interaction.reply({
          content: "🛡️Rules acknowledged. You may submit an application.🛡️",
          flags: 64});
      }

      // Apply open -> show modal (only if rules accepted + no pending request)
      if (interaction.customId === CID.APPLY_OPEN_25 || interaction.customId === CID.APPLY_OPEN_100) {
        if (!interaction.guild) {
          return interaction.reply({ content: "Guild only.", flags: 64});
        }
        if (!state.rulesAcceptedRoleId || !state.adminChannelId || !state.adminRoleId) {
          return interaction.reply({
            content: "Bot not setup yet. Ask an admin to run /setup.",
            flags: 64});
        }

        const serverType =
          interaction.customId === CID.APPLY_OPEN_25 ? "25x PVP" : "100x PVP Chaos";
        const modalId =
          interaction.customId === CID.APPLY_OPEN_25 ? CID.APPLY_MODAL_25 : CID.APPLY_MODAL_100;

        requests = readJson(REQUESTS_PATH, {});
        const pending = getPendingRequestForUser(interaction.user.id);
        if (pending) {
          return interaction.reply({
            content: "You already have a pending White Flag application. Please wait for admin review.",
            flags: 64});
        }

        const member = await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null);
        if (!member) return interaction.reply({ content: "Could not fetch member.", flags: 64});

        if (!member.roles.cache.has(state.rulesAcceptedRoleId)) {
          return interaction.reply({
            content: "You must read and accept the White Flag rules before submitting an application.",
            flags: 64});
        }

        const modal = new ModalBuilder()
          .setCustomId(modalId)
          .setTitle(`White Flag Application — ${serverType}`);

        const ign = new TextInputBuilder()
          .setCustomId("ign")
          .setLabel("IGN")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64);

        const tribe = new TextInputBuilder()
          .setCustomId("tribe")
          .setLabel("Tribe Name")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64);

        const map = new TextInputBuilder()
          .setCustomId("map")
          .setLabel("Map")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64);

        modal.addComponents(
          new ActionRowBuilder().addComponents(ign),
          new ActionRowBuilder().addComponents(tribe),
          new ActionRowBuilder().addComponents(map)
        );

        return interaction.showModal(modal);
      }

      // Admin actions
      if (
        interaction.customId.startsWith(CID.ADMIN_APPROVE_PREFIX) ||
        interaction.customId.startsWith(CID.ADMIN_DENY_PREFIX) ||
        interaction.customId.startsWith(CID.ADMIN_END_EARLY_PREFIX)
      ) {
        if (!interaction.guild) return interaction.reply({ content: "Guild only.", flags: 64});

        // Optional: enforce that admin actions happen inside admin channel
        if (state.adminChannelId && interaction.channelId !== state.adminChannelId) {
          return interaction.reply({
            content: "Admin actions must be used in the admin review channel.",
            flags: 64});
        }

        // Permission check: must have admin role OR Administrator permission
        const member = await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null);
        const isAdminPerm =
          member?.permissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
        const hasAdminRole = state.adminRoleId ? member?.roles?.cache?.has(state.adminRoleId) : false;

        if (!isAdminPerm && !hasAdminRole) {
          return interaction.reply({ content: "Admins only.", flags: 64});
        }

        const requestId = interaction.customId.split(":")[1];
        requests = readJson(REQUESTS_PATH, {});
        const req = requests[requestId];
        if (!req) {
          return interaction.reply({ content: "Request not found (maybe already handled).", flags: 64});
        }

        // Approve
        if (interaction.customId.startsWith(CID.ADMIN_APPROVE_PREFIX)) {
          if (req.status !== "pending") {
            return interaction.reply({ content: `Already ${req.status}.`, flags: 64 });
          }

          // Enforce one active White Flag per tribe
          const existingActive = getActiveApprovedForTribe(req.tribeName, requestId);
          if (existingActive) {
            return interaction.reply({
              content:
                `❌ Cannot approve. Tribe **${escapeMd(req.tribeName)}** already has an active White Flag ` +
                `(ID: \`${existingActive.id}\`) ending ${fmtDiscordRelativeTime(existingActive.approvedAt + SEVEN_DAYS_MS)}.`,
              flags: 64,
            });
          }

          req.status = "approved";
          req.approvedAt = Date.now();
          req.approvedBy = interaction.user.id;
          requests[requestId] = req;
          persist();

          scheduleExpiry(requestId);
          scheduleWhiteFlagExpiryWarning(requestId);
          maybeSendTestAlert({ kind: "whiteflag", requestId, req, realWarnAt: null });

          // Update admin message components: disable approve/deny, add "End Early" button
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${CID.ADMIN_END_EARLY_PREFIX}${requestId}`)
              .setLabel("🛑 End Early (Open Season)")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(`${CID.ADMIN_DENY_PREFIX}${requestId}`)
              .setLabel("❌ Deny")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId(`${CID.ADMIN_APPROVE_PREFIX}${requestId}`)
              .setLabel("✅ Approved")
              .setStyle(ButtonStyle.Success)
              .setDisabled(true)
          );

          await interaction.update({
            content: interaction.message.content,
            embeds: interaction.message.embeds,
            components: [row],
          });

          // Optionally DM user
          const user = await bot.users.fetch(req.requestedBy).catch(() => null);
          if (user) {
            user
              .send(
                `🛡️White Flag APPROVED for **${req.tribeName}** (${req.serverType || req.cluster || "Server"}) was approved. Protection lasts 7 days from approval.`
              )
              .catch(() => null);
          }

          return;
        }

        // Deny
        if (interaction.customId.startsWith(CID.ADMIN_DENY_PREFIX)) {
          if (req.status !== "pending") {
            return interaction.reply({ content: `Already ${req.status}.`, flags: 64 });
          }
          req.status = "denied";
          req.deniedAt = Date.now();
          req.deniedBy = interaction.user.id;
          requests[requestId] = req;
          persist();

          // Disable buttons
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${CID.ADMIN_DENY_PREFIX}${requestId}`)
              .setLabel("❌ Denied")
              .setStyle(ButtonStyle.Danger)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId(`${CID.ADMIN_APPROVE_PREFIX}${requestId}`)
              .setLabel("✅ Approve")
              .setStyle(ButtonStyle.Success)
              .setDisabled(true)
          );

          await interaction.update({
            content: interaction.message.content,
            embeds: interaction.message.embeds,
            components: [row],
          });

          const user = await bot.users.fetch(req.requestedBy).catch(() => null);
          if (user) {
            user
              .send(
                `🛡️White Flag DENIED for **${req.tribeName}** (${req.serverType || req.cluster || "Server"}) was denied. If you think this is a mistake, contact an admin.`
              )
              .catch(() => null);
          }

          return;
        }

        // End early -> Open Season ping
        if (interaction.customId.startsWith(CID.ADMIN_END_EARLY_PREFIX)) {
          if (req.status !== "approved") {
            return interaction.reply({
              content: `Cannot end early because status is **${req.status}**.`,
              flags: 64,
            });
          }

          // Cancel timer
          const t = activeTimeouts.get(requestId);
          if (t) clearTimeout(t);
          activeTimeouts.delete(requestId);

          req.status = "ended_early";
          req.endedEarlyAt = Date.now();
          req.endedEarlyBy = interaction.user.id;

          // Start/refresh a 2-week bounty automatically
          const nowB = Date.now();
          req.bounty = {
            active: true,
            startedAt: nowB,
            endsAt: nowB + ONE_WEEK_MS,
            startedBy: interaction.user.id,
            reason: "White Flag ended early (Open Season).",
          };
          requests[requestId] = req;
          persist();

          scheduleBountyExpiry(requestId);
          scheduleBountyExpiryWarning(requestId);

          // Announce Open Season (ping role)
          const announceCh = await interaction.guild.channels
            .fetch(state.announceChannelId)
            .catch(() => null);

          if (announceCh && isTextChannel(announceCh)) {
            await announceCh.send(
              `<@&${state.openSeasonRoleId}> 🚨 **OPEN SEASON** — Protection TERMINATED for **${escapeMd(
                req.tribeName
              )}** (IGN: **${escapeMd(req.ign)}**, Server: **${escapeMd(
                req.serverType || req.cluster || "N/A"
              )}**).`
            );

            const bountyCh = await safeFetchChannel(
              interaction.guild,
              state.bountyAnnounceChannelId || state.announceChannelId || state.adminChannelId
            ).catch(() => null);

            if (bountyCh && isTextChannel(bountyCh)) {
              const claimRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`bounty_claim_open:${req.id}`)
                  .setLabel("Claim Bounty")
                  .setStyle(ButtonStyle.Primary)
              );

              const bountyMsg = await bountyCh.send({
                content:
                  `🎯 **BOUNTY ISSUED** — **${escapeMd(req.tribeName)}** ` +
                  `(IGN: **${escapeMd(req.ign)}**, Server: **${escapeMd(
                    req.serverType || req.cluster || "N/A"
                  )}**) — Reward: **${BOUNTY_REWARD}** — Duration: **7 days** — Ends ${fmtDiscordRelativeTime(
                    req.bounty.endsAt
                  )}.`,
                components: [claimRow],
              });
            // Store the announcement message so we can disable it when claimed/removed
              req.bounty.announceChannelId = bountyCh.id;
              req.bounty.announceMessageId = bountyMsg.id;
              requests[requestId] = req;
              persist();
}
          }

          // Update admin message: disable end early
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${CID.ADMIN_END_EARLY_PREFIX}${requestId}`)
              .setLabel("🛑 Ended Early")
              .setStyle(ButtonStyle.Danger)
              .setDisabled(true)
          );

          await interaction.update({
            content: interaction.message.content,
            embeds: interaction.message.embeds,
            components: [row],
          });

          const user = await bot.users.fetch(req.requestedBy).catch(() => null);
          if (user) {
            user
              .send(
                `🛡️Protection TERMINATED for **${req.tribeName}** (${req.serverType || req.cluster || "Server"}). Your tribe is now OPEN SEASON.`
              )
              .catch(() => null);
          }

          return;
        }
      }
    }

    // -------------------- Modal submit --------------------
    if (interaction.type === InteractionType.ModalSubmit) {
      // ---- Player: submit bounty claim modal ----
      if (interaction.customId.startsWith("bounty_claim_submit:")) {
        if (!interaction.guild) {
          return interaction.reply({ content: "Guild only.", flags: 64});
        }
        if (!state.adminChannelId) {
          return interaction.reply({
            content: "Bot not setup yet. Ask an admin to run /setup.",
            flags: 64});
        }

        const [, recordId] = interaction.customId.split(":");

        // Re-load latest data
        requests = readJson(REQUESTS_PATH, {});
        claims = readJson(CLAIMS_PATH, {});

        const target = requests[recordId];
        const now = Date.now();

        if (!target || !hasActiveBounty(target, now)) {
          return interaction.reply({
            content: "This bounty is no longer active.",
            flags: 64});
        }

        const ign = (interaction.fields.getTextInputValue("ign") || "").trim();
        const bountyIgn = (interaction.fields.getTextInputValue("bounty_ign") || "").trim();
        const proofRaw = (interaction.fields.getTextInputValue("proof") || "").trim();
        const proof = proofRaw.length ? proofRaw : "N/A";

        if (!ign || !bountyIgn) {
          return interaction.reply({ content: "IGN fields are required.", flags: 64});
        }

        const claimId = newClaimId();
        const claim = {
          id: claimId,
          bountyRecordId: target.id,
          tribeName: target.tribeName,
          reward: BOUNTY_REWARD,
          submittedBy: interaction.user.id,
          submittedAt: now,
          claimantIgn: ign,
          bountyTargetIgn: bountyIgn,
          proof,
          status: "pending",
        };

        claims[claimId] = claim;
        persistClaims();

        const adminCh = await safeFetchChannel(interaction.guild, state.adminChannelId);
        if (adminCh && isTextChannel(adminCh)) {
          const embed = new EmbedBuilder()
            .setTitle("🎯 Bounty Claim Submitted")
            .setDescription(
              `Target Tribe: **${escapeMd(target.tribeName)}**\n` +
                `Target IGN: **${escapeMd(target.ign || "N/A")}**\n` +
                `Reward: **${BOUNTY_REWARD}**\n` +
                `Submitted by: <@${interaction.user.id}>\n` +
                `Claimant IGN: **${escapeMd(ign)}**\n` +
                `Bounty Target IGN: **${escapeMd(bountyIgn)}**\n` +
                `Proof: ${proof}\n` +
                `Record ID: \`${target.id}\`\nClaim ID: \`${claimId}\``
            );

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`bounty_claim_approve:${claimId}`)
              .setLabel("Approve")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`bounty_claim_deny:${claimId}`)
              .setLabel("Deny")
              .setStyle(ButtonStyle.Danger)
          );

          await adminCh.send({ embeds: [embed], components: [row] });
        }

        return interaction.reply({
          content: "✅ Claim submitted for admin review.",
          flags: 64});
      }

      const is25 = interaction.customId === CID.APPLY_MODAL_25;
      const is100 = interaction.customId === CID.APPLY_MODAL_100;
      if (!is25 && !is100) return;
      if (!interaction.guild) return interaction.reply({ content: "Guild only.", flags: 64});

      if (!state.adminChannelId || !state.adminRoleId) {
        return interaction.reply({
          content: "Bot not setup yet. Ask an admin to run /setup.",
          flags: 64});
      }

      const serverType = is25 ? "25x PVP" : "100x PVP Chaos";

      // Re-check rules role gate
      const member = await interaction.guild.members
        .fetch(interaction.user.id)
        .catch(() => null);
      if (!member || !member.roles.cache.has(state.rulesAcceptedRoleId)) {
        return interaction.reply({
          content: "You must accept the rules before submitting an application.",
          flags: 64});
      }

      const ign = interaction.fields.getTextInputValue("ign")?.trim();
      const tribe = interaction.fields.getTextInputValue("tribe")?.trim();
      const map = interaction.fields.getTextInputValue("map")?.trim();

      if (!ign || !tribe || !map) {
        return interaction.reply({ content: "All fields are required.", flags: 64});
      }

      // Prevent duplicate pending requests (race-safe-ish)
      requests = readJson(REQUESTS_PATH, {});
      const pending = getPendingRequestForUser(interaction.user.id);
      if (pending) {
        return interaction.reply({
          content: "You already have a pending White Flag application. Please wait for admin review.",
          flags: 64});
      }

      // Enforce one active White Flag per tribe (block submission too)
      const existingActive = getActiveApprovedForTribe(tribe);
      if (existingActive) {
        return interaction.reply({
          content:
            `❌ That tribe already has an active White Flag (ID: \`${existingActive.id}\`) ` +
            `ending ${fmtDiscordRelativeTime(existingActive.approvedAt + SEVEN_DAYS_MS)}.`,
          flags: 64,
        });
      }

      const requestId = newRequestId();
      const req = {
        id: requestId,
        status: "pending",
        ign,
        tribeName: tribe,
        cluster: serverType,   // kept for backwards compatibility with older data
        serverType,            // explicit
        map,
        requestedBy: interaction.user.id,
        requestedAt: Date.now(),
      };

      requests[requestId] = req;
      persist();

      const adminCh = await interaction.guild.channels.fetch(state.adminChannelId).catch(() => null);
      if (!adminCh || !isTextChannel(adminCh)) {
        return interaction.reply({
          content: "Admin channel not found. Ask an admin to rerun /setup.",
          flags: 64});
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${CID.ADMIN_APPROVE_PREFIX}${requestId}`)
          .setLabel("✅ Approve (Start 7 Days)")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${CID.ADMIN_DENY_PREFIX}${requestId}`)
          .setLabel("❌ Deny")
          .setStyle(ButtonStyle.Danger)
      );

      // Ping admin role on submission
      await adminCh.send({
        content: `<@&${state.adminRoleId}> New White Flag application received.`,
        embeds: [buildAdminReviewEmbed(req)],
        components: [row],
      });

      return interaction.reply({
        content: `🛡️Application submitted for **${serverType}**! Admins have been notified.🛡️`,
        flags: 64,
      });
    }
  } catch (err) {
    console.error("interaction error:", err);
    if (interaction && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: "Something went wrong.", flags: 64});
      } catch {
        // ignore reply errors
      }
    }
  }
});


// -------------------- Railway/hosting keep-alive (optional) --------------------
// Some hosts expect a process to bind to PORT. If PORT is set, we start a tiny HTTP server.
const http = require("http");
const PORT = process.env.PORT;
if (PORT) {
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    })
    .listen(PORT, () => console.log(`✅ Health server listening on ${PORT}`));
}

bot.login(TOKEN);