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
  } catch (_e) {
    // Attempt recovery from most recent backup (if any)
    try {
      const backupDir = path.join(DATA_DIR, "backups");
      const base = path.basename(filePath);
      if (fs.existsSync(backupDir)) {
        const candidates = fs
          .readdirSync(backupDir)
          .filter((n) => n.startsWith(`${base}.`) && n.endsWith(".bak"))
          .sort()
          .reverse();
        if (candidates.length) {
          const raw2 = fs.readFileSync(path.join(backupDir, candidates[0]), "utf8");
          return JSON.parse(raw2);
        }
      }
    } catch {
      // ignore
    }
    return fallback;
  }
}

function writeJson(filePath, obj) {
  const tmp = `${filePath}.tmp`;

  // Backup previous version
  try {
    if (fs.existsSync(filePath)) {
      const backupDir = path.join(DATA_DIR, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const base = path.basename(filePath);
      const stamp = Date.now().toString();
      const backupPath = path.join(backupDir, `${base}.${stamp}.bak`);
      fs.copyFileSync(filePath, backupPath);

      // Keep only the last 10 backups per file
      const keep = 10;
      const candidates = fs
        .readdirSync(backupDir)
        .filter((n) => n.startsWith(`${base}.`) && n.endsWith(".bak"))
        .sort()
        .reverse();
      for (const old of candidates.slice(keep)) {
        fs.unlinkSync(path.join(backupDir, old));
      }
    }
  } catch {
    // ignore backup failures
  }

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


function uniqNonNull(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
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
      // Re-read latest in case of changes
      requests = readJson(REQUESTS_PATH, {});
      const r = requests[requestId];
      if (!r || !r.bounty) return;

      const now2 = Date.now();
      // Only expire if it is actually due and still active
      if (!(r.bounty.active === true && typeof r.bounty.endsAt === "number" && r.bounty.endsAt <= now2)) return;

      r.bounty.active = false;
      r.bounty.expiredAt = now2;
      requests[requestId] = r;
      persist();

      const guild = await safeFetchGuild(bot);
      if (!guild) return;

      // Announce bounty closed (optional)
      const announceCh = await safeFetchChannel(guild, state.announceChannelId);
      if (announceCh && isTextChannel(announceCh)) {
        await announceCh.send(
          `🏁 **BOUNTY CLOSED** — Target cleared for **${escapeMd(r.tribeName)}** (IGN: **${escapeMd(
            r.ign
          )}**, Server: **${escapeMd(r.serverType || r.cluster || "N/A")}**).`
        );
      }

      // Disable the bounty announcement button (if stored)
      try {
        const chId = r.bounty.announceChannelId;
        const msgId = r.bounty.announceMessageId;
        if (chId && msgId) {
          const bountyCh = await guild.channels.fetch(chId).catch(() => null);
          if (bountyCh && isTextChannel(bountyCh)) {
            const msg = await bountyCh.messages.fetch(msgId).catch(() => null);
            if (msg) {
              await msg.edit({ content: msg.content + "\n🏁 **CLOSED**", components: [] }).catch(() => null);
            }
          }
        }
      } catch {
        // ignore
      }
    } catch (e) {
      console.error("Bounty expiry failed:", e);
    } finally {
      activeBountyTimeouts.delete(requestId);
    }
  }, delay);

  activeBountyTimeouts.set(requestId, t);
}

async function approveBountyClaim(interaction, claimId) {
  const claim = claims[claimId];
  if (!claim) {
    return interaction.reply({ content: "Claim not found.", flags: 64 });
  }

  const req = requests[claim.bountyRecordId];
  if (!req) {
    return interaction.reply({ content: "Bounty record not found.", flags: 64 });
  }

  claim.status = "approved";
  claim.approvedAt = Date.now();
  claim.approvedBy = interaction.user.id;
  claims[claimId] = claim;

  req.bounty.claimStatus = "approved";
  requests[claim.bountyRecordId] = req;
  persistClaims();
  persist();

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

  
// Reward log / closure notice
try {
  const adminCh = await safeFetchChannel(interaction.guild, state.adminChannelId);
  const bountyCh = await safeFetchChannel(
    interaction.guild,
    state.bountyAnnounceChannelId || state.announceChannelId || state.adminChannelId
  );

  const claimant = claim.claimantIgn ? `Claimant IGN: **${escapeMd(claim.claimantIgn)}**\n` : "";
  const targetIgn = claim.bountyTargetIgn ? `Target IGN (claimed): **${escapeMd(claim.bountyTargetIgn)}**\n` : "";
  const proofLine = claim.proof ? `Proof: ${claim.proof}\n` : "";
  const notesLine = claim.notes ? `Notes: ${escapeMd(claim.notes)}\n` : "";

  const msg =
    `✅ **BOUNTY CLAIM APPROVED**\n` +
    `Tribe: **${escapeMd(claim.tribeName)}**\n` +
    `${targetIgn}${claimant}` +
    `Reward: **${BOUNTY_REWARD}**\n` +
    `Approved by: <@${interaction.user.id}>\n` +
    `Submitted by: <@${claim.submittedBy}>\n` +
    proofLine +
    notesLine +
    `Claim ID: \`${claimId}\`  Record ID: \`${claim.bountyRecordId}\``;

  if (adminCh && isTextChannel(adminCh)) await adminCh.send(msg);
  if (bountyCh && isTextChannel(bountyCh)) await bountyCh.send(msg);
} catch {
  // ignore
}

return interaction.update({
    content: interaction.message.content,
    embeds: interaction.message.embeds,
    components: [row],
  });
}

// -------------------- Interaction handler --------------------
bot.on("interactionCreate", async (interaction) => {
  try {
    // Button interactions
    if (interaction.isButton()) {
      // Bounty claim approve/deny
      if (interaction.customId.startsWith("bounty_claim_approve:")) {
        const claimId = interaction.customId.split(":")[1];
        return approveBountyClaim(interaction, claimId);
      }

      if (interaction.customId.startsWith("bounty_claim_deny:")) {
        const claimId = interaction.customId.split(":")[1];
        const claim = claims[claimId];
        if (!claim) {
          return interaction.reply({ content: "Claim not found.", flags: 64 });
        }

        const req = requests[claim.bountyRecordId];
        if (!req) {
          return interaction.reply({ content: "Bounty record not found.", flags: 64 });
        }

        claim.status = "denied";
        claim.deniedAt = Date.now();
        claim.deniedBy = interaction.user.id;
        claims[claimId] = claim;

        req.bounty.claimStatus = "denied";
        requests[claim.bountyRecordId] = req;
        persistClaims();
        persist();

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

      // Bounty claim open
      if (interaction.customId.startsWith("bounty_claim_open:")) {
        if (!interaction.guild) {
          return interaction.reply({ content: "Guild only.", flags: 64 });
        }

        const recordId = interaction.customId.split(":")[1];
        requests = readJson(REQUESTS_PATH, {});
        const target = requests[recordId];
        const now = Date.now();

        if (!target || !hasActiveBounty(target, now)) {
          return interaction.reply({
            content: "This bounty is no longer active.",
            flags: 64,
          });
        }

        const modal = new ModalBuilder()
          .setCustomId(`bounty_claim_submit:${recordId}`)
          .setTitle("Claim Bounty");

        const ign = new TextInputBuilder()
          .setCustomId("ign")
          .setLabel("Your IGN")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64);

        const bountyIgn = new TextInputBuilder()
          .setCustomId("bounty_ign")
          .setLabel("Target IGN (the one you killed)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64);

        const proof = new TextInputBuilder()
          .setCustomId("proof")
          .setLabel("Proof (screenshot URL, etc.)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(256);

        modal.addComponents(
          new ActionRowBuilder().addComponents(ign),
          new ActionRowBuilder().addComponents(bountyIgn),
          new ActionRowBuilder().addComponents(proof)
        );

        return interaction.showModal(modal);
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

if (target?.bounty?.claimStatus === "pending") {
  return interaction.reply({
    content: "A claim for this bounty is already pending admin review.",
    flags: 64,
  });
}
if (target?.bounty?.claimStatus === "approved") {
  return interaction.reply({
    content: "This bounty has already been claimed.",
    flags: 64,
  });
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
        // Lock this bounty to prevent duplicate claims
        target.bounty.claimStatus = "pending";
        target.bounty.claimId = claimId;
        target.bounty.claimLockedAt = now;
        requests[recordId] = target;
        persist();

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