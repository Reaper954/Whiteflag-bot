// index.js — EXODUS OVERSEER (Railway production)
// Discord.js v14, Node 18+
//
// IMPORTANT (Railway):
// - This bot does NOT use privileged intents (no GuildMembers intent) to avoid "Used disallowed intents".
// - Role assignment on rules accept uses interaction.member (available on guild interactions).
//
// Env:
//   DISCORD_TOKEN (required)
//   CLIENT_ID     (required) - for slash command registration (optional if you register via commands.js)
//   GUILD_ID      (optional) - if set, registers to this guild on startup
//   DATA_DIR      (optional) defaults ./data
//   PORT          (optional) health server port (Railway uses 8080)
//
// Storage: JSON files in DATA_DIR

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");

const {
  Client,
  GatewayIntentBits,
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
const CLIENT_ID = process.env.CLIENT_ID || null;
const GUILD_ID = process.env.GUILD_ID || null;


/**
 * Admin control roles (either role grants full control over admin actions).
 * Users with Discord Administrator permission are also allowed.
 */
const CONTROL_ROLE_NAMES = ["EXODUS BOT Creator", "White Flag Handler"];

function memberHasControlRole(member) {
  try {
    if (!member || !member.roles || !member.roles.cache) return false;
    return member.roles.cache.some((r) => CONTROL_ROLE_NAMES.includes(r.name));
  } catch {
    return false;
  }
}

function memberIsAdminOverride(member) {
  try {
    return member?.permissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
  } catch {
    return false;
  }
}

function requireControl(interaction, member) {
  const ok = memberIsAdminOverride(member) || memberHasControlRole(member);
  if (ok) return true;
  interaction.reply({ content: "⛔ You don’t have permission to use this action.", ephemeral: true }).catch(() => null);
  return false;
}

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

// -------------------- Health server --------------------
const PORT = Number(process.env.PORT || 8080);
http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  })
  .listen(PORT, () => console.log(`✅ Health server listening on ${PORT}`));

// -------------------- Storage --------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const STATE_PATH = path.join(DATA_DIR, "state.json");
const REQUESTS_PATH = path.join(DATA_DIR, "requests.json");
const CLAIMS_PATH = path.join(DATA_DIR, "claims.json");

// ---- JSON helpers with rolling backups ----
function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    // attempt last backup
    try {
      const base = path.basename(filePath);
      const files = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith(base + ".") && f.endsWith(".bak"))
        .sort()
        .reverse();
      if (files.length) {
        const raw = fs.readFileSync(path.join(BACKUP_DIR, files[0]), "utf8");
        console.warn(`⚠️ JSON parse failed for ${filePath}. Restoring from backup ${files[0]}`);
        return JSON.parse(raw);
      }
    } catch {
      // ignore
    }
    return fallback;
  }
}

function writeJsonWithBackup(filePath, obj) {
  const base = path.basename(filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `${base}.${stamp}.bak`);
  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, backupPath);
    } else {
      fs.writeFileSync(backupPath, JSON.stringify(obj, null, 2), "utf8");
    }
    // keep last 10 backups per file
    const backups = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith(base + ".") && f.endsWith(".bak"))
      .sort()
      .reverse();
    for (const extra of backups.slice(10)) {
      fs.unlinkSync(path.join(BACKUP_DIR, extra));
    }
  } catch {
    // ignore backup errors
  }

  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

// -------------------- Persisted state --------------------
/**
 * state = {
 *  guildId,
 *  rulesChannelId,
 *  applyChannelId,
 *  adminChannelId,
 *  announceChannelId,
 *  bountyAnnounceChannelId,
 *  bountyClaimsChannelId,
 *  adminRoleId,
 *  openSeasonRoleId,
 *  rulesAcceptedRoleId,
 *  rulesMessageId,
 *  applyMessageId
 * }
 */
let state = safeReadJson(STATE_PATH, {
  guildId: null,
  rulesChannelId: null,
  applyChannelId: null,
  adminChannelId: null,
  announceChannelId: null,
  bountyAnnounceChannelId: null,
  bountyClaimsChannelId: null,
  adminRoleId: null,
  openSeasonRoleId: null,
  rulesAcceptedRoleId: null,
  rulesMessageId: null,
  applyMessageId: null,
});

let requests = safeReadJson(REQUESTS_PATH, {});
let claims = safeReadJson(CLAIMS_PATH, {});

// -------------------- Constants --------------------
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const BOUNTY_REWARD = "2,000 tokens";

const CID = {
  RULES_ACCEPT: "wf_rules_accept",
  APPLY_OPEN_25: "wf_apply_open_25",
  APPLY_OPEN_100: "wf_apply_open_100",
  APPLY_MODAL_25: "wf_apply_modal_25",
  APPLY_MODAL_100: "wf_apply_modal_100",
  ADMIN_APPROVE_PREFIX: "wf_admin_approve:",
  ADMIN_DENY_PREFIX: "wf_admin_deny:",
  ADMIN_END_EARLY_PREFIX: "wf_admin_end:",
  BOUNTY_CLAIM_OPEN_PREFIX: "bounty_claim_open:",
  BOUNTY_CLAIM_SUBMIT_PREFIX: "bounty_claim_submit:",
  BOUNTY_CLAIM_APPROVE_PREFIX: "bounty_claim_approve:",
  BOUNTY_CLAIM_DENY_PREFIX: "bounty_claim_deny:",
};

// -------------------- Helpers --------------------
function persistAll() {
  writeJsonWithBackup(STATE_PATH, state);
  writeJsonWithBackup(REQUESTS_PATH, requests);
}

function persistClaims() {
  writeJsonWithBackup(CLAIMS_PATH, claims);
}

function escapeMd(str) {
  if (!str) return "";
  return String(str).replace(/([*_`~|>])/g, "\\$1");
}


function hasBotStaffRole(member) {
  try {
    const allowed = ["EXODUS BOT Creator", "White Flag Handler"];
    if (!member || !member.roles || !member.roles.cache) return false;
    return member.roles.cache.some((role) => allowed.includes(role.name));
  } catch {
    return false;
  }
}

function denyNoRole(interaction, msg = "⛔ You do not have permission to use this command.") {
  return interaction.reply({ content: msg, flags: 64 });
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

function fmtDiscordRelativeTime(msEpoch) {
  const seconds = Math.floor(msEpoch / 1000);
  return `<t:${seconds}:R>`;
}

function normalizeTribeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function newRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newClaimId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isApprovedAndActive(req, now = Date.now()) {
  return req && req.status === "approved" && typeof req.approvedAt === "number" && req.approvedAt + SEVEN_DAYS_MS > now;
}

function hasActiveBounty(req, now = Date.now()) {
  return req && req.bounty && req.bounty.active === true && typeof req.bounty.endsAt === "number" && req.bounty.endsAt > now;
}

function getActiveBountyForTribe(tribeName) {
  const key = normalizeTribeName(tribeName);
  const now = Date.now();
  for (const r of Object.values(requests)) {
    if (normalizeTribeName(r?.tribeName) !== key) continue;
    if (hasActiveBounty(r, now)) return r;
  }
  return null;
}

function getActiveApprovedForTribe(tribeName) {
  const key = normalizeTribeName(tribeName);
  const now = Date.now();
  for (const r of Object.values(requests)) {
    if (normalizeTribeName(r?.tribeName) !== key) continue;
    if (isApprovedAndActive(r, now)) return r;
  }
  return null;
}

async function safeFetchGuild(client) {
  if (!state.guildId) return null;
  return client.guilds.fetch(state.guildId).catch(() => null);
}
async function safeFetchChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  return guild.channels.fetch(channelId).catch(() => null);
}


async function safeDmUser(client, userId, content) {
  try {
    if (!userId) return false;
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return false;
    await user.send(content).catch(() => null);
    return true;
  } catch {
    return false;
  }
}

// -------------------- Timers --------------------
const activeTimeouts = new Map();
const activeBountyTimeouts = new Map();
const activeWfAlertTimeouts = new Map();
const activeBountyAlertTimeouts = new Map();

function scheduleExpiry(requestId) {
  const req = requests[requestId];
  if (!req || req.status !== "approved" || !req.approvedAt) return;

  const existing = activeTimeouts.get(requestId);
  if (existing) clearTimeout(existing);

  const now = Date.now();
  const endsAt = req.approvedAt + SEVEN_DAYS_MS;
  const delay = Math.max(0, endsAt - now);

  const t = setTimeout(async () => {
    try {
      requests = safeReadJson(REQUESTS_PATH, {});
      const r = requests[requestId];
      if (!r || r.status !== "approved") return;

      r.status = "expired";
      r.expiredAt = Date.now();
      requests[requestId] = r;
      persistAll();

      // DM requester
      await safeDmUser(bot, r.requestedBy, `⏳ Your White Flag protection for **${escapeMd(r.tribeName)}** has **EXPIRED**.`);

      const guild = await safeFetchGuild(bot);
      if (!guild) return;
      const adminCh = await safeFetchChannel(guild, state.bountyClaimsChannelId || state.adminChannelId);
      if (adminCh && isTextChannel(adminCh)) {
        await adminCh.send(`⏳ PROTECTION EXPIRED — White Flag ended for **${escapeMd(r.tribeName)}**.`);
      }
    } finally {
      activeTimeouts.delete(requestId);
    }
  }, delay);

  activeTimeouts.set(requestId, t);
}

function scheduleWhiteFlagExpiryWarning(requestId) {
  const req = requests[requestId];
  if (!req || req.status !== "approved" || !req.approvedAt) return;
  if (req.wfWarnedAt) return;

  const endsAt = req.approvedAt + SEVEN_DAYS_MS;
  const warnAt = endsAt - ONE_DAY_MS;
  const delay = Math.max(0, warnAt - Date.now());

  const existing = activeWfAlertTimeouts.get(requestId);
  if (existing) clearTimeout(existing);

  const t = setTimeout(async () => {
    try {
      requests = safeReadJson(REQUESTS_PATH, {});
      const r = requests[requestId];
      if (!isApprovedAndActive(r)) return;
      if (r.wfWarnedAt) return;

      r.wfWarnedAt = Date.now();
      requests[requestId] = r;
      persistAll();

      const guild = await safeFetchGuild(bot);
      if (!guild) return;
      const adminCh = await safeFetchChannel(guild, state.bountyClaimsChannelId || state.adminChannelId);
      if (adminCh && isTextChannel(adminCh)) {
        const ping = state.adminRoleId ? `<@&${state.adminRoleId}> ` : "";
        await adminCh.send(`${ping}⚠️ White Flag for **${escapeMd(r.tribeName)}** expires in **24 hours**. Ends ${fmtDiscordRelativeTime(endsAt)} (ID: \`${r.id}\`).`);
      }
    } finally {
      activeWfAlertTimeouts.delete(requestId);
    }
  }, delay);

  activeWfAlertTimeouts.set(requestId, t);
}

function scheduleBountyExpiryWarning(requestId) {
  const req = requests[requestId];
  if (!hasActiveBounty(req)) return;
  if (req.bountyWarnedAt) return;

  const warnAt = req.bounty.endsAt - ONE_DAY_MS;
  const delay = Math.max(0, warnAt - Date.now());

  const existing = activeBountyAlertTimeouts.get(requestId);
  if (existing) clearTimeout(existing);

  const t = setTimeout(async () => {
    try {
      requests = safeReadJson(REQUESTS_PATH, {});
      const r = requests[requestId];
      if (!hasActiveBounty(r)) return;
      if (r.bountyWarnedAt) return;

      r.bountyWarnedAt = Date.now();
      requests[requestId] = r;
      persistAll();

      const guild = await safeFetchGuild(bot);
      if (!guild) return;
      const adminCh = await safeFetchChannel(guild, state.bountyClaimsChannelId || state.adminChannelId);
      if (adminCh && isTextChannel(adminCh)) {
        const ping = state.adminRoleId ? `<@&${state.adminRoleId}> ` : "";
        await adminCh.send(`${ping}⚠️ Bounty on **${escapeMd(r.tribeName)}** expires in **24 hours**. Ends ${fmtDiscordRelativeTime(r.bounty.endsAt)} (ID: \`${r.id}\`).`);
      }
    } finally {
      activeBountyAlertTimeouts.delete(requestId);
    }
  }, delay);

  activeBountyAlertTimeouts.set(requestId, t);
}

function scheduleBountyExpiry(requestId) {
  const req = requests[requestId];
  if (!hasActiveBounty(req)) return;

  const existing = activeBountyTimeouts.get(requestId);
  if (existing) clearTimeout(existing);

  const delay = Math.max(0, req.bounty.endsAt - Date.now());

  const t = setTimeout(async () => {
    try {
      requests = safeReadJson(REQUESTS_PATH, {});
      const r = requests[requestId];
      if (!r || !r.bounty) return;
      const now2 = Date.now();
      if (!(r.bounty.active === true && typeof r.bounty.endsAt === "number" && r.bounty.endsAt <= now2)) return;

      r.bounty.active = false;
      r.bounty.expiredAt = now2;
      requests[requestId] = r;
      persistAll();

      const guild = await safeFetchGuild(bot);
      if (!guild) return;

      // Disable claim button if we stored message ids
      try {
        const chId = r.bounty.announceChannelId;
        const msgId = r.bounty.announceMessageId;
        if (chId && msgId) {
          const bountyCh = await guild.channels.fetch(chId).catch(() => null);
          if (bountyCh && isTextChannel(bountyCh)) {
            const msg = await bountyCh.messages.fetch(msgId).catch(() => null);
            if (msg) await msg.edit({ content: msg.content + "\n🏁 **CLOSED**", components: [] }).catch(() => null);
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

// On startup: expire overdue items and re-schedule
async function expireOverdueOnStartup() {
  try {
    requests = safeReadJson(REQUESTS_PATH, {});
    const now = Date.now();
    let changed = false;

    for (const r of Object.values(requests)) {
      if (r?.status === "approved" && r?.approvedAt && r.approvedAt + SEVEN_DAYS_MS <= now) {
        r.status = "expired";
        r.expiredAt = now;
        changed = true;
      }
      if (r?.bounty?.active && typeof r.bounty.endsAt === "number" && r.bounty.endsAt <= now) {
        r.bounty.active = false;
        r.bounty.expiredAt = now;
        changed = true;
      }
    }
    if (changed) persistAll();
  } catch (e) {
    console.error("expireOverdueOnStartup failed:", e);
  }
}

// -------------------- Panels --------------------
function buildRulesEmbed() {
  return new EmbedBuilder()
    .setTitle("🛡️White Flag Protocol🛡️")
    .setDescription(
      [
        "**PROTOCOL:** This system grants temporary protection to new tribes. Abuse triggers enforcement and may result in an active bounty.",
        "",
        "**Eligibility & Duration**",
        "• White Flag is for **new tribes only**.",
        "• Protection lasts **7 days from approval**.",
        "• Admins may remove early if rules are broken.",
        "",
        "**While White Flag is Active**",
        "• **YOU CAN NOT RAID OTHER TRIBES.**",
        "• Build, farm, tame, establish your base.",
        "• PvP is allowed as long as you are not raiding/scouting bases.",
        "",
        "**Violations**",
        "• Raiding while under White Flag = **immediate removal**.",
        "• Abuse of protection = **removal**.",
        "• If you break rules: White Flag removed and a bounty will be placed on your tribe.",
      ].join("\n")
    );
}

function buildRulesRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CID.RULES_ACCEPT).setLabel("✅ I Agree & Understand").setStyle(ButtonStyle.Success)
  );
}

function buildApplyEmbed() {
  return new EmbedBuilder()
    .setTitle("🛡️White Flag Applications🛡️")
    .setDescription(
      ["Before applying, you must read and accept the rules.", "", "Choose:", "• **25x PVP**", "• **100x PVP Chaos**", "", "**Important:** Only **1 White Flag per tribe.**"].join("\n")
    );
}

function buildApplyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CID.APPLY_OPEN_25).setLabel("🏳️ Apply — 25x PVP").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(CID.APPLY_OPEN_100).setLabel("🏳️ Apply — 100x PVP Chaos").setStyle(ButtonStyle.Secondary)
  );
}

function buildAdminReviewEmbed(req) {
  const endsAt = req.approvedAt ? req.approvedAt + SEVEN_DAYS_MS : null;
  const e = new EmbedBuilder()
    .setTitle("🛡️Application Received🛡️")
    .addFields(
      { name: "Server", value: escapeMd(req.serverType || "N/A"), inline: true },
      { name: "IGN", value: escapeMd(req.ign || "N/A"), inline: true },
      { name: "Tribe Name", value: escapeMd(req.tribeName || "N/A"), inline: true },
      { name: "Map", value: escapeMd(req.map || "N/A"), inline: true },
      { name: "Requested By", value: `<@${req.requestedBy}>`, inline: false }
    )
    .setFooter({ text: `Request ID: ${req.id}` });
  if (endsAt) e.addFields({ name: "Ends", value: fmtDiscordRelativeTime(endsAt), inline: true });
  return e;
}

function buildAdminReviewRow(reqId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${CID.ADMIN_APPROVE_PREFIX}${reqId}`).setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${CID.ADMIN_DENY_PREFIX}${reqId}`).setLabel("Deny").setStyle(ButtonStyle.Danger)
  );
}

function buildEndEarlyRow(reqId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${CID.ADMIN_END_EARLY_PREFIX}${reqId}`).setLabel("End Early (Force Bounty)").setStyle(ButtonStyle.Danger)
  );
}

function ensureRulesAcceptedRoleId(guild) {
  // non-privileged approach: we store role id if provided; /setup will create if missing
  return state.rulesAcceptedRoleId || null;
}

// -------------------- Slash command registration (optional) --------------------
async function registerSlashCommandsOnStartup() {
  if (!CLIENT_ID) return;
  const commands = [
    new SlashCommandBuilder()
      .setName("setup")
      .setDescription("Post rules + apply panels and configure channels/roles for White Flag.")
      .addChannelOption((o) => o.setName("rules_channel").setDescription("Rules channel").setRequired(true))
      .addChannelOption((o) => o.setName("apply_channel").setDescription("Apply channel").setRequired(true))
      .addChannelOption((o) => o.setName("admin_channel").setDescription("Admin review channel").setRequired(true))
      .addChannelOption((o) => o.setName("announce_channel").setDescription("Announcements channel").setRequired(true))
      .addRoleOption((o) => o.setName("admin_role").setDescription("Admin_role").setRequired(true))
      .addRoleOption((o) => o.setName("pvp_role").setDescription("pvp_role").setRequired(true))
      .addChannelOption((o) => o.setName("bounty_claims_review_channel").setDescription("Channel for bounty claim admin logs (optional)").setRequired(false))
      .addChannelOption((o) => o.setName("bounty_channel").setDescription("Bounty channel (optional)").setRequired(false)),
    new SlashCommandBuilder().setName("rules").setDescription("Show rules"),
    new SlashCommandBuilder().setName("whiteflags").setDescription("White Flag utilities.").addSubcommand((sc) => sc.setName("active").setDescription("Show active White Flags")),
    new SlashCommandBuilder().setName("bounties").setDescription("Bounty utilities.").addSubcommand((sc) => sc.setName("active").setDescription("Show active bounties")),
    new SlashCommandBuilder()
      .setName("bounty")
      .setDescription("Create, remove, or claim bounties.")
      .addSubcommand((sc) =>
        sc
          .setName("add")
          .setDescription("Add/refresh a bounty for a tribe (1 week).")
          .addStringOption((opt) => opt.setName("tribe").setDescription("Tribe name").setRequired(true))
          .addStringOption((opt) => opt.setName("ign").setDescription("Target IGN (optional)").setRequired(false))
          .addStringOption((opt) => opt.setName("server").setDescription("Server/Cluster (optional)").setRequired(false))
          .addStringOption((opt) => opt.setName("reason").setDescription("Reason (optional)").setRequired(false))
      )
      .addSubcommand((sc) =>
        sc
          .setName("remove")
          .setDescription("Remove an active bounty by tribe or ID.")
          .addStringOption((opt) => opt.setName("tribe").setDescription("Tribe name").setRequired(false))
          .addStringOption((opt) => opt.setName("id").setDescription("Bounty record ID").setRequired(false))
      )
      .addSubcommand((sc) =>
        sc
          .setName("claim")
          .setDescription("Submit a bounty claim (admin review).")
          .addStringOption((opt) => opt.setName("tribe").setDescription("Bounty tribe").setRequired(true))
          .addStringOption((opt) => opt.setName("ign").setDescription("Your IGN").setRequired(true))
          .addStringOption((opt) => opt.setName("bounty_ign").setDescription("Bounty target IGN").setRequired(true))
          .addStringOption((opt) => opt.setName("proof").setDescription("Proof link/text").setRequired(true))
          .addStringOption((opt) => opt.setName("notes").setDescription("Optional notes").setRequired(false))
      ),
    new SlashCommandBuilder()
      .setName("admin")
      .setDescription("Admin dashboards.")
      .addSubcommand((sc) =>
        sc
          .setName("bounties")
          .setDescription("List bounties")
          .addStringOption((o) =>
            o
              .setName("filter")
              .setDescription("active|expired|all")
              .setRequired(false)
              .addChoices({ name: "active", value: "active" }, { name: "expired", value: "expired" }, { name: "all", value: "all" })
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName("claims")
          .setDescription("List claims")
          .addStringOption((o) =>
            o
              .setName("filter")
              .setDescription("pending|approved|denied|all")
              .setRequired(false)
              .addChoices({ name: "pending", value: "pending" }, { name: "approved", value: "approved" }, { name: "denied", value: "denied" }, { name: "all", value: "all" })
          )
      ),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log("✅ Slash commands registered (guild)");
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("✅ Slash commands registered (global)");
    }
  } catch (e) {
    console.error("Slash command registration failed:", e);
  }
}

// -------------------- Discord client --------------------
const bot = new Client({
  intents: [GatewayIntentBits.Guilds], // no privileged intents
});

bot.once("clientReady", async () => {
  console.log(`✅ Logged in as ${bot.user.tag} — build clean_v5_combined_open_season_bounty`);

  await registerSlashCommandsOnStartup();
  await expireOverdueOnStartup();

  // Re-schedule timers
  try {
    requests = safeReadJson(REQUESTS_PATH, {});
    const now = Date.now();
    for (const [id, r] of Object.entries(requests)) {
      if (isApprovedAndActive(r, now)) {
        scheduleExpiry(id);
        scheduleWhiteFlagExpiryWarning(id);
      }
      if (hasActiveBounty(r, now)) {
        scheduleBountyExpiry(id);
        scheduleBountyExpiryWarning(id);
      }
    }
  } catch (e) {
    console.error("Failed to reschedule timers:", e);
  }
});

// -------------------- Interaction handler --------------------
bot.on("interactionCreate", async (interaction) => {
  try {
    // ---------- Slash commands ----------
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      if (cmd === "setup") {
        if (!hasBotStaffRole(interaction.member)) { return denyNoRole(interaction); }
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: "Guild only.", flags: 64 });

        const rulesChannel = interaction.options.getChannel("rules_channel");
        const applyChannel = interaction.options.getChannel("apply_channel");
        const adminChannel = interaction.options.getChannel("admin_channel");
        const announceChannel = interaction.options.getChannel("announce_channel");
        const bountyChannel = interaction.options.getChannel("bounty_channel");
        const bountyClaimsChannel = interaction.options.getChannel("bounty_claims_channel");
        const adminRole = interaction.options.getRole("admin_role");
        const openSeasonRole = interaction.options.getRole("open_season_role");

        if (![rulesChannel, applyChannel, adminChannel, announceChannel].every(isTextChannel)) {
          return interaction.reply({ content: "All channels must be text channels.", flags: 64 });
        }

        state.guildId = guild.id;
        state.rulesChannelId = rulesChannel.id;
        state.applyChannelId = applyChannel.id;
        state.adminChannelId = adminChannel.id;
        state.announceChannelId = announceChannel.id;
        state.bountyAnnounceChannelId = bountyChannel && isTextChannel(bountyChannel) ? bountyChannel.id : null;
        state.bountyClaimsChannelId = bountyClaimsChannel && isTextChannel(bountyClaimsChannel) ? bountyClaimsChannel.id : null;
        state.adminRoleId = adminRole?.id || null;
        state.openSeasonRoleId = openSeasonRole?.id || null;

        // ensure Rules Accepted role exists or create
        await guild.roles.fetch().catch(() => null);
        let ra = state.rulesAcceptedRoleId ? await guild.roles.fetch(state.rulesAcceptedRoleId).catch(() => null) : null;
        if (!ra) {
          ra = guild.roles.cache.find((r) => r.name.toLowerCase() === "rules accepted") || null;
        }
        if (!ra) {
          ra = await guild.roles
            .create({ name: "Rules Accepted", mentionable: false, reason: "White Flag bot: rules gate" })
            .catch(() => null);
        }
        if (!ra) return interaction.reply({ content: "Failed to create/find Rules Accepted role.", flags: 64 });

        state.rulesAcceptedRoleId = ra.id;

        const rulesMsg = await rulesChannel.send({ embeds: [buildRulesEmbed()], components: [buildRulesRow()] });
        const applyMsg = await applyChannel.send({ embeds: [buildApplyEmbed()], components: [buildApplyRow()] });

        state.rulesMessageId = rulesMsg.id;
        state.applyMessageId = applyMsg.id;
        persistAll();

        return interaction.reply({ content: "✅ Setup complete.", flags: 64 });
      }

      if (cmd === "rules") {
        return interaction.reply({ embeds: [buildRulesEmbed()], flags: 64 });
      }

      if (cmd === "whiteflags" && interaction.options.getSubcommand() === "active") {
        const now = Date.now();
        const active = Object.values(requests).filter((r) => isApprovedAndActive(r, now));
        if (!active.length) return interaction.reply({ content: "No active White Flags.", flags: 64 });

        const lines = active
          .slice(0, 25)
          .map((r) => `• **${escapeMd(r.tribeName)}** — ends ${fmtDiscordRelativeTime(r.approvedAt + SEVEN_DAYS_MS)} (ID: \`${r.id}\`)`);
        return interaction.reply({ content: lines.join("\n"), flags: 64 });
      }

      if (cmd === "bounties" && interaction.options.getSubcommand() === "active") {
        const now = Date.now();
        const active = Object.values(requests).filter((r) => hasActiveBounty(r, now));
        if (!active.length) return interaction.reply({ content: "No active bounties.", flags: 64 });

        const lines = active
          .slice(0, 25)
          .map((r) => `• **${escapeMd(r.tribeName)}** — ends ${fmtDiscordRelativeTime(r.bounty.endsAt)} (ID: \`${r.id}\`)`);
        return interaction.reply({ content: lines.join("\n"), flags: 64 });
      }

      if (cmd === "admin") {
        if (!hasBotStaffRole(interaction.member)) { return denyNoRole(interaction); }
        const sub = interaction.options.getSubcommand();
        if (sub === "bounties") {
          const filter = interaction.options.getString("filter") || "active";
          const now = Date.now();
          let list = Object.values(requests).filter((r) => r?.bounty);
          if (filter === "active") list = list.filter((r) => hasActiveBounty(r, now));
          if (filter === "expired") list = list.filter((r) => r?.bounty && !hasActiveBounty(r, now));
          const lines = list.slice(0, 25).map((r) => `• **${escapeMd(r.tribeName)}** — ${r.bounty.active ? "ACTIVE" : "INACTIVE"} — ID: \`${r.id}\``);
          return interaction.reply({ content: lines.length ? lines.join("\n") : "No results.", flags: 64 });
        }
        if (sub === "claims") {
          const filter = interaction.options.getString("filter") || "pending";
          let list = Object.values(claims);
          if (filter !== "all") list = list.filter((c) => c.status === filter);
          const lines = list
            .slice(0, 25)
            .map((c) => `• **${escapeMd(c.tribeName)}** — ${c.status.toUpperCase()} — Claim ID: \`${c.id}\` — Record: \`${c.bountyRecordId}\``);
          return interaction.reply({ content: lines.length ? lines.join("\n") : "No results.", flags: 64 });
        }
      }

      if (cmd === "bounty") {
        const sub = interaction.options.getSubcommand();

        if (sub === "add") {
          if (!hasBotStaffRole(interaction.member)) { return denyNoRole(interaction); }
          const tribe = (interaction.options.getString("tribe") || "").trim();
          const ign = (interaction.options.getString("ign") || "").trim();
          const server = (interaction.options.getString("server") || "").trim();
          const reason = (interaction.options.getString("reason") || "").trim();
          if (!tribe) return interaction.reply({ content: "Tribe is required.", flags: 64 });

          const existing = getActiveBountyForTribe(tribe);
          const now = Date.now();

          let record;
          if (existing) {
            existing.bounty.active = true;
            existing.bounty.startedAt = now;
            existing.bounty.endsAt = now + ONE_WEEK_MS;
            existing.bounty.startedBy = interaction.user.id;
            existing.bounty.reason = reason || existing.bounty.reason || "Manual bounty created.";
            if (ign) existing.ign = ign;
            if (server) existing.serverType = server;
            requests[existing.id] = existing;
            persistAll();
            scheduleBountyExpiry(existing.id);
            scheduleBountyExpiryWarning(existing.id);
            record = existing;
          } else {
            const id = newRequestId();
            record = {
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
                // claim lock
                locked: false,
                lockedByClaimId: null,
              },
            };
            requests[id] = record;
            persistAll();
            scheduleBountyExpiry(id);
            scheduleBountyExpiryWarning(id);
          }

          // Announce with Claim button
          const guild = interaction.guild;
          const bountyCh = await safeFetchChannel(
            guild,
            state.bountyAnnounceChannelId || state.announceChannelId || state.adminChannelId
          );
          if (bountyCh && isTextChannel(bountyCh)) {
            const claimRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`${CID.BOUNTY_CLAIM_OPEN_PREFIX}${record.id}`)
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

            // store message ids for auto-disable
            record.bounty.announceChannelId = bountyCh.id;
            record.bounty.announceMessageId = bountyMsg.id;
            requests[record.id] = record;
            persistAll();
          }

          return interaction.reply({
            content: `✅ Bounty issued for **${escapeMd(record.tribeName)}**. Ends ${fmtDiscordRelativeTime(record.bounty.endsAt)} (ID: \`${record.id}\`).`,
            flags: 64,
          });
        }

        if (sub === "remove") {
          if (!hasBotStaffRole(interaction.member)) { return denyNoRole(interaction); }
          const tribe = (interaction.options.getString("tribe") || "").trim();
          const id = (interaction.options.getString("id") || "").trim();
          if (!tribe && !id) return interaction.reply({ content: "Provide tribe or id.", flags: 64 });

          let target = null;
          if (id) target = requests[id] || null;
          if (!target && tribe) target = getActiveBountyForTribe(tribe);

          if (!target || !target.bounty || !target.bounty.active) {
            return interaction.reply({ content: "No active bounty found.", flags: 64 });
          }

          const t = activeBountyTimeouts.get(target.id);
          if (t) clearTimeout(t);
          activeBountyTimeouts.delete(target.id);

          target.bounty.active = false;
          target.bounty.removedAt = Date.now();
          target.bounty.removedBy = interaction.user.id;
          target.bounty.locked = false;
          target.bounty.lockedByClaimId = null;
          requests[target.id] = target;
          persistAll();

          // disable claim post
          try {
            const guild = interaction.guild;
            const chId = target.bounty.announceChannelId;
            const msgId = target.bounty.announceMessageId;
            if (guild && chId && msgId) {
              const bountyCh = await guild.channels.fetch(chId).catch(() => null);
              if (bountyCh && isTextChannel(bountyCh)) {
                const msg = await bountyCh.messages.fetch(msgId).catch(() => null);
                if (msg) await msg.edit({ content: msg.content + "\n🛑 **CANCELED**", components: [] }).catch(() => null);
              }
            }
          } catch {
            // ignore
          }

          return interaction.reply({ content: `✅ Removed bounty for **${escapeMd(target.tribeName)}**.`, flags: 64 });
        }

        if (sub === "claim") {
          const tribe = (interaction.options.getString("tribe") || "").trim();
          const ign = (interaction.options.getString("ign") || "").trim();
          const bountyIgn = (interaction.options.getString("bounty_ign") || "").trim();
          const proof = (interaction.options.getString("proof") || "").trim();
          const notes = (interaction.options.getString("notes") || "").trim();

          if (!tribe || !ign || !bountyIgn || !proof) return interaction.reply({ content: "Missing required fields.", flags: 64 });

          const target = getActiveBountyForTribe(tribe);
          if (!target) return interaction.reply({ content: "No active bounty for that tribe.", flags: 64 });

          // claim lock
          if (target.bounty.locked) {
            return interaction.reply({ content: "This bounty already has a pending claim under review.", flags: 64 });
          }

          const claimId = newClaimId();
          const claim = {
            id: claimId,
            bountyRecordId: target.id,
            tribeName: target.tribeName,
            reward: BOUNTY_REWARD,
            submittedBy: interaction.user.id,
            submittedAt: Date.now(),
            claimantIgn: ign,
            bountyTargetIgn: bountyIgn,
            proof,
            notes: notes || "",
            status: "pending",
          };
          claims[claimId] = claim;
          persistClaims();

          target.bounty.locked = true;
          target.bounty.lockedByClaimId = claimId;
          requests[target.id] = target;
          persistAll();

          const guild = interaction.guild;
          const adminCh = await safeFetchChannel(guild, state.bountyClaimsChannelId || state.adminChannelId);
          if (adminCh && isTextChannel(adminCh)) {
            const embed = new EmbedBuilder()
              .setTitle("🎯 Bounty Claim Submitted")
              .setDescription(
                `Tribe: **${escapeMd(target.tribeName)}**\n` +
                  `Reward: **${BOUNTY_REWARD}**\n` +
                  `Submitted by: <@${interaction.user.id}>\n` +
                  `Claimant IGN: **${escapeMd(ign)}**\n` +
                  `Bounty Target IGN: **${escapeMd(bountyIgn)}**\n` +
                  `Proof: ${proof}\n` +
                  (notes ? `Notes: ${escapeMd(notes)}\n` : "") +
                  `Record ID: \`${target.id}\`\nClaim ID: \`${claimId}\``
              );

            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`${CID.BOUNTY_CLAIM_APPROVE_PREFIX}${claimId}`).setLabel("Approve").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`${CID.BOUNTY_CLAIM_DENY_PREFIX}${claimId}`).setLabel("Deny").setStyle(ButtonStyle.Danger)
            );

            await adminCh.send({ embeds: [embed], components: [row] });
          }

          return interaction.reply({ content: "✅ Claim submitted for admin review.", flags: 64 });
        }

        if (sub === "status") {
          const tribe = (interaction.options.getString("tribe") || "").trim();
          const id = (interaction.options.getString("id") || "").trim();
          if (!tribe && !id) return interaction.reply({ content: "Provide tribe or id.", flags: 64 });

          let target = null;
          if (id) target = requests[id] || null;
          if (!target && tribe) target = getActiveBountyForTribe(tribe) || getActiveApprovedForTribe(tribe);

          if (!target) return interaction.reply({ content: "Not found.", flags: 64 });

          const isActive = hasActiveBounty(target);
          const lockLine = target.bounty?.locked ? `\nClaim status: **PENDING REVIEW**` : "";
          const endLine = isActive ? `Ends ${fmtDiscordRelativeTime(target.bounty.endsAt)}` : "Not active";
          return interaction.reply({ content: `Bounty for **${escapeMd(target.tribeName)}**: **${isActive ? "ACTIVE" : "INACTIVE"}** — ${endLine}${lockLine}\nRecord ID: \`${target.id}\``, flags: 64 });
        }
      }
    }

    // ---------- Buttons ----------
    if (interaction.isButton()) {
      // Rules accept
      if (interaction.customId === CID.RULES_ACCEPT) {
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: "Guild only.", flags: 64 });
        const roleId = ensureRulesAcceptedRoleId(guild);
        if (!roleId) return interaction.reply({ content: "Bot not setup. Ask an admin to run /setup.", flags: 64 });

        // interaction.member is a GuildMember-like object here
        try {
          await interaction.member.roles.add(roleId).catch(() => null);
        } catch {
          // ignore
        }
        return interaction.reply({ content: "✅ Rules accepted. You may now apply.", flags: 64 });
      }

      // Open apply modals
      if (interaction.customId === CID.APPLY_OPEN_25 || interaction.customId === CID.APPLY_OPEN_100) {
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: "Guild only.", flags: 64 });

        const roleId = state.rulesAcceptedRoleId;
        if (roleId && !interaction.member.roles.cache?.has(roleId)) {
          return interaction.reply({ content: "You must accept the rules first.", flags: 64 });
        }

        const is25 = interaction.customId === CID.APPLY_OPEN_25;
        const modal = new ModalBuilder().setCustomId(is25 ? CID.APPLY_MODAL_25 : CID.APPLY_MODAL_100).setTitle(is25 ? "White Flag — 25x PVP" : "White Flag — 100x PVP Chaos");

        const ign = new TextInputBuilder().setCustomId("ign").setLabel("Your in-game name (IGN)").setStyle(TextInputStyle.Short).setRequired(true);
        const tribe = new TextInputBuilder().setCustomId("tribe").setLabel("Tribe name").setStyle(TextInputStyle.Short).setRequired(true);
        const map = new TextInputBuilder().setCustomId("map").setLabel("Map").setStyle(TextInputStyle.Short).setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(ign), new ActionRowBuilder().addComponents(tribe), new ActionRowBuilder().addComponents(map));
        return interaction.showModal(modal);
      }

      // Admin approve/deny whiteflag
      if (interaction.customId.startsWith(CID.ADMIN_APPROVE_PREFIX) || interaction.customId.startsWith(CID.ADMIN_DENY_PREFIX)) {
        if (!hasBotStaffRole(interaction.member)) { return denyNoRole(interaction); }
        const isApprove = interaction.customId.startsWith(CID.ADMIN_APPROVE_PREFIX);
        const requestId = interaction.customId.split(":")[1];
        requests = safeReadJson(REQUESTS_PATH, {});
        const req = requests[requestId];
        if (!req) return interaction.reply({ content: "Request not found.", flags: 64 });

        if (!isApprove) {
          req.status = "denied";
          req.deniedAt = Date.now();
          req.deniedBy = interaction.user.id;
          requests[requestId] = req;
          persistAll();
          // DM requester
          await safeDmUser(bot, req.requestedBy, `❌ Your White Flag request for **${escapeMd(req.tribeName)}** was **DENIED**.`);

// Disable buttons on the admin review message
try {
  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CID.ADMIN_APPROVE_PREFIX}${requestId}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${CID.ADMIN_DENY_PREFIX}${requestId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true)
  );
  if (interaction.message && interaction.message.edit) {
    await interaction.message.edit({ components: [disabledRow] }).catch(() => null);
  }
} catch {
  // ignore
}

          return interaction.reply({ content: `❌ Denied White Flag for **${escapeMd(req.tribeName)}**.`, flags: 64 });
        }

        // Approve
        // enforce 1 active per tribe
        const existing = getActiveApprovedForTribe(req.tribeName);
        if (existing && existing.id !== req.id) {
          return interaction.reply({ content: "That tribe already has an active White Flag.", flags: 64 });
        }

        req.status = "approved";
        req.approvedAt = Date.now();
        req.approvedBy = interaction.user.id;
        requests[requestId] = req;
        persistAll();

        // DM requester
        await safeDmUser(bot, req.requestedBy, `✅ Your White Flag request for **${escapeMd(req.tribeName)}** was **APPROVED**. Protection ends ${fmtDiscordRelativeTime(req.approvedAt + SEVEN_DAYS_MS)}.`);

        scheduleExpiry(requestId);
        scheduleWhiteFlagExpiryWarning(requestId);

// Update admin review message: disable approve/deny and add End Early button
try {
  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CID.ADMIN_APPROVE_PREFIX}${requestId}`)
      .setLabel("Approved")
      .setStyle(ButtonStyle.Success)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${CID.ADMIN_DENY_PREFIX}${requestId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true)
  );
  const endRow = buildEndEarlyRow(requestId);
  if (interaction.message && interaction.message.edit) {
    await interaction.message.edit({ components: [disabledRow, endRow] }).catch(() => null);
  }
} catch {
  // ignore
}


        return interaction.reply({ content: `✅ Approved White Flag for **${escapeMd(req.tribeName)}**. Ends ${fmtDiscordRelativeTime(req.approvedAt + SEVEN_DAYS_MS)}.`, flags: 64 });
      }

      // Admin end early (bounty)
      if (interaction.customId.startsWith(CID.ADMIN_END_EARLY_PREFIX)) {
        if (!hasBotStaffRole(interaction.member)) { return denyNoRole(interaction); }
        const requestId = interaction.customId.split(":")[1];
        requests = safeReadJson(REQUESTS_PATH, {});
        const req = requests[requestId];
        if (!req) return interaction.reply({ content: "Request not found.", flags: 64 });

        req.status = "ended_early";
        req.endedEarlyAt = Date.now();
        req.endedEarlyBy = interaction.user.id;

        // Create/refresh bounty
        const now = Date.now();
        if (!req.bounty) req.bounty = {};
        req.bounty.active = true;
        req.bounty.startedAt = now;
        req.bounty.endsAt = now + ONE_WEEK_MS;
        req.bounty.startedBy = interaction.user.id;
        req.bounty.reason = "White Flag ended early.";
        req.bounty.locked = false;
        req.bounty.lockedByClaimId = null;

        requests[requestId] = req;
        persistAll();

        // DM requester
        await safeDmUser(bot, req.requestedBy, `🛑 Your White Flag for **${escapeMd(req.tribeName)}** was **ENDED EARLY** by admins.A bounty has been issued for your tribe.`);

        scheduleBountyExpiry(requestId);
        scheduleBountyExpiryWarning(requestId);

        const guild = interaction.guild;
        const announceCh = await safeFetchChannel(guild, state.announceChannelId);
        const openPing = state.openSeasonRoleId ? `<@&${state.openSeasonRoleId}> ` : "";
        if (announceCh && isTextChannel(announceCh)) {
          await announceCh.send(` Bounty issued for tribe **${escapeMd(req.tribeName)}**.`);
        }

        // Post bounty + claim button
        const bountyCh = await safeFetchChannel(guild, state.bountyAnnounceChannelId || state.announceChannelId || state.adminChannelId);
        if (bountyCh && isTextChannel(bountyCh)) {
          const claimRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${CID.BOUNTY_CLAIM_OPEN_PREFIX}${req.id}`).setLabel("Claim Bounty").setStyle(ButtonStyle.Primary)
          );
          const bountyMsg = await bountyCh.send({
            content:
              `${state.openSeasonRoleId ? `<@&${state.openSeasonRoleId}> ` : ``}🎯 **BOUNTY HAS BEEN ISSUED FOR** **${escapeMd(req.tribeName)}** ` +
              `**, Server: **${escapeMd(req.serverType || "N/A")}**) — ` +
              `Reward: **${BOUNTY_REWARD}** — ends ${fmtDiscordRelativeTime(req.bounty.endsAt)}.`,
            components: [claimRow],
          });

          req.bounty.announceChannelId = bountyCh.id;
          req.bounty.announceMessageId = bountyMsg.id;
          requests[requestId] = req;
          persistAll();
        }

        return interaction.reply({ content: "✅ Ended early and bounty has been issued.", flags: 64 });
      }

      // Open bounty claim modal from button
      if (interaction.customId.startsWith(CID.BOUNTY_CLAIM_OPEN_PREFIX)) {
        const recordId = interaction.customId.split(":")[1];
        requests = safeReadJson(REQUESTS_PATH, {});
        const target = requests[recordId];
        if (!target || !hasActiveBounty(target)) {
          return interaction.reply({ content: "This bounty is no longer active.", flags: 64 });
        }
        if (target.bounty.locked) {
          return interaction.reply({ content: "This bounty already has a pending claim under review.", flags: 64 });
        }

        const modal = new ModalBuilder().setCustomId(`${CID.BOUNTY_CLAIM_SUBMIT_PREFIX}${recordId}`).setTitle("Bounty Claim");
        const ign = new TextInputBuilder().setCustomId("ign").setLabel("Your IGN").setStyle(TextInputStyle.Short).setRequired(true);
        const bountyIgn = new TextInputBuilder().setCustomId("bounty_ign").setLabel("Bounty Target IGN").setStyle(TextInputStyle.Short).setRequired(true);
        const proof = new TextInputBuilder().setCustomId("proof").setLabel("Proof (clip/link/text)").setStyle(TextInputStyle.Paragraph).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(ign), new ActionRowBuilder().addComponents(bountyIgn), new ActionRowBuilder().addComponents(proof));
        return interaction.showModal(modal);
      }

      // Approve/Deny bounty claim
      if (interaction.customId.startsWith(CID.BOUNTY_CLAIM_APPROVE_PREFIX) || interaction.customId.startsWith(CID.BOUNTY_CLAIM_DENY_PREFIX)) {
        if (!hasBotStaffRole(interaction.member)) { return denyNoRole(interaction); }

        const approve = interaction.customId.startsWith(CID.BOUNTY_CLAIM_APPROVE_PREFIX);
        const claimId = interaction.customId.split(":")[1];

        claims = safeReadJson(CLAIMS_PATH, {});
        requests = safeReadJson(REQUESTS_PATH, {});
        const claim = claims[claimId];
        if (!claim) return interaction.reply({ content: "Claim not found.", flags: 64 });

        const target = requests[claim.bountyRecordId];
        if (!target || !target.bounty) return interaction.reply({ content: "Bounty record not found.", flags: 64 });

        if (approve) {
          claim.status = "approved";
          claim.approvedAt = Date.now();
          claim.approvedBy = interaction.user.id;
          claims[claimId] = claim;
          persistClaims();

          // Close bounty
          target.bounty.active = false;
          target.bounty.claimedAt = Date.now();
          target.bounty.claimedBy = claim.submittedBy;
          target.bounty.locked = true;
          target.bounty.lockedByClaimId = claimId;
          requests[target.id] = target;
          persistAll();

          // Disable claim post
          try {
            const guild = interaction.guild;
            const chId = target.bounty.announceChannelId;
            const msgId = target.bounty.announceMessageId;
            if (guild && chId && msgId) {
              const bountyCh = await guild.channels.fetch(chId).catch(() => null);
              if (bountyCh && isTextChannel(bountyCh)) {
                const msg = await bountyCh.messages.fetch(msgId).catch(() => null);
                if (msg) await msg.edit({ content: msg.content + "\n✅ **CLAIMED**", components: [] }).catch(() => null);
              }
            }
          } catch {
            // ignore
          }

          // ONE log only (no short duplicate)
          const adminCh = await safeFetchChannel(interaction.guild, state.bountyClaimsChannelId || state.adminChannelId);
          const outCh = adminCh && isTextChannel(adminCh) ? adminCh : null;

          const details =
            `✅ **BOUNTY CLAIM APPROVED**\n` +
            `Tribe: **${escapeMd(claim.tribeName)}**\n` +
            `Target IGN (claimed): **${escapeMd(claim.bountyTargetIgn)}**\n` +
            `Claimant IGN: **${escapeMd(claim.claimantIgn)}**\n` +
            `Reward: **${BOUNTY_REWARD}**\n` +
            `Approved by: <@${interaction.user.id}>\n` +
            `Submitted by: <@${claim.submittedBy}>\n` +
            `Proof: ${claim.proof}\n` +
            (claim.notes ? `Notes: ${escapeMd(claim.notes)}\n` : "") +
            `Claim ID: \`${claim.id}\`  Record ID: \`${claim.bountyRecordId}\``;

          if (outCh) await outCh.send(details);

// Post a public "claimed" notice in the bounty channel (or announce channel), if different from admin channel
try {
  const guild = interaction.guild;
  const bountyCh = await safeFetchChannel(
    guild,
    state.bountyAnnounceChannelId || state.announceChannelId || state.adminChannelId
  );
  if (bountyCh && isTextChannel(bountyCh)) {
    // Avoid double-posting in the same channel as the detailed admin log
    if (!outCh || bountyCh.id !== outCh.id) {
      await bountyCh.send(
        `🏁 **BOUNTY CLAIMED** on tribe **${escapeMd(claim.tribeName)}** by <@${claim.submittedBy}>.`
      );
    }
  }
} catch {
  // ignore
}


          return interaction.reply({ content: "✅ Claim approved and bounty closed.", flags: 64 });
        }

        // Deny
        claim.status = "denied";
        claim.deniedAt = Date.now();
        claim.deniedBy = interaction.user.id;
        claims[claimId] = claim;
        persistClaims();

        // unlock bounty so someone else can claim
        target.bounty.locked = false;
        target.bounty.lockedByClaimId = null;
        requests[target.id] = target;
        persistAll();

        return interaction.reply({ content: "❌ Claim denied (bounty unlocked).", flags: 64 });
      }
    }

    // ---------- Modal submits ----------
    if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId === CID.APPLY_MODAL_25 || interaction.customId === CID.APPLY_MODAL_100) {
        const is25 = interaction.customId === CID.APPLY_MODAL_25;
        const ign = (interaction.fields.getTextInputValue("ign") || "").trim();
        const tribe = (interaction.fields.getTextInputValue("tribe") || "").trim();
        const map = (interaction.fields.getTextInputValue("map") || "").trim();

        if (!ign || !tribe || !map) return interaction.reply({ content: "All fields required.", flags: 64 });

        // enforce 1 active per tribe
        const existing = getActiveApprovedForTribe(tribe);
        if (existing) return interaction.reply({ content: "That tribe already has an active White Flag.", flags: 64 });

        const id = newRequestId();
        const record = {
          id,
          status: "pending",
          serverType: is25 ? "25x PVP" : "100x PVP Chaos",
          ign,
          tribeName: tribe,
          map,
          requestedBy: interaction.user.id,
          requestedAt: Date.now(),
        };
        requests[id] = record;
        persistAll();

        const guild = interaction.guild;
        const adminCh = await safeFetchChannel(guild, state.bountyClaimsChannelId || state.adminChannelId);
        if (adminCh && isTextChannel(adminCh)) {
          const ping = state.adminRoleId ? `<@&${state.adminRoleId}> ` : "";
          await adminCh.send({ content: ping, embeds: [buildAdminReviewEmbed(record)], components: [buildAdminReviewRow(id)] });
        }

        return interaction.reply({ content: "✅ Submitted. An admin will review it.", flags: 64 });
      }

      // bounty claim submit modal
      if (interaction.customId.startsWith(CID.BOUNTY_CLAIM_SUBMIT_PREFIX)) {
        const recordId = interaction.customId.split(":")[1];
        requests = safeReadJson(REQUESTS_PATH, {});
        claims = safeReadJson(CLAIMS_PATH, {});
        const target = requests[recordId];
        if (!target || !hasActiveBounty(target)) return interaction.reply({ content: "This bounty is no longer active.", flags: 64 });
        if (target.bounty.locked) return interaction.reply({ content: "This bounty already has a pending claim under review.", flags: 64 });

        const ign = (interaction.fields.getTextInputValue("ign") || "").trim();
        const bountyIgn = (interaction.fields.getTextInputValue("bounty_ign") || "").trim();
        const proof = (interaction.fields.getTextInputValue("proof") || "").trim();
        if (!ign || !bountyIgn || !proof) return interaction.reply({ content: "All fields required.", flags: 64 });

        const claimId = newClaimId();
        const claim = {
          id: claimId,
          bountyRecordId: target.id,
          tribeName: target.tribeName,
          reward: BOUNTY_REWARD,
          submittedBy: interaction.user.id,
          submittedAt: Date.now(),
          claimantIgn: ign,
          bountyTargetIgn: bountyIgn,
          proof,
          notes: "",
          status: "pending",
        };
        claims[claimId] = claim;
        persistClaims();

        target.bounty.locked = true;
        target.bounty.lockedByClaimId = claimId;
        requests[target.id] = target;
        persistAll();

        const adminCh = await safeFetchChannel(interaction.guild, state.bountyClaimsChannelId || state.adminChannelId);
        if (adminCh && isTextChannel(adminCh)) {
          const embed = new EmbedBuilder()
            .setTitle("🎯 Bounty Claim Submitted")
            .setDescription(
              `Tribe: **${escapeMd(target.tribeName)}**\n` +
                `Reward: **${BOUNTY_REWARD}**\n` +
                `Submitted by: <@${interaction.user.id}>\n` +
                `Claimant IGN: **${escapeMd(ign)}**\n` +
                `Bounty Target IGN: **${escapeMd(bountyIgn)}**\n` +
                `Proof: ${proof}\n` +
                `Record ID: \`${target.id}\`\nClaim ID: \`${claimId}\``
            );

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${CID.BOUNTY_CLAIM_APPROVE_PREFIX}${claimId}`).setLabel("Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`${CID.BOUNTY_CLAIM_DENY_PREFIX}${claimId}`).setLabel("Deny").setStyle(ButtonStyle.Danger)
          );

          await adminCh.send({ embeds: [embed], components: [row] });
        }

        return interaction.reply({ content: "✅ Claim submitted for admin review.", flags: 64 });
      }
    }
  } catch (e) {
    console.error("interaction error:", e);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Something went wrong.", flags: 64 });
      }
    } catch {
      // ignore
    }
  }
});

bot.login(TOKEN);
