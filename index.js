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

// Active timers in memory: requestId -> timeout
const activeTimeouts = new Map();

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
          `⏳ White Flag expired for **${escapeMd(r.tribeName)}** (IGN: **${escapeMd(
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
              `⏳ White Flag expired (while bot was offline) for **${escapeMd(
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
  } catch (e) {
    console.error("Failed to expire overdue approvals:", e);
  }
}

// -------------------- Rules / Apply panels --------------------
function buildRulesEmbed() {
  return new EmbedBuilder()
    .setTitle("📜 White Flag Rules & Agreement")
    .setDescription(
      [
        "The White Flag system is designed to give new tribes a fair start and time to build. Abuse of this system will result in removal and a bounty placed on your tribe’s head.",
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
        "• If you break the rules, your flag will be removed, your tribe will be announced as **OPEN SEASON**, and a bounty will be placed on your tribe.",
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
    .setTitle("🏳️ White Flag Applications")
    .setDescription(
      [
        "Before applying, you must read and accept the rules.",
        "",
        "Choose the correct server and submit your request:",
        "• **25x PVP**",
        "• **100x PVP Chaos**",
        "",
        "**Important:** Only **1 active White Flag per tribe** is allowed.",
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
    .setTitle("📥 New White Flag Application")
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
      ),
    new SlashCommandBuilder()
      .setName("rules")
      .setDescription("Show the White Flag rules (ephemeral)."),
    new SlashCommandBuilder()
      .setName("whiteflags")
      .setDescription("White Flag utilities.")
      .addSubcommand((sc) =>
        sc.setName("active").setDescription("Show all approved + active White Flags.")
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
  } catch (e) {
    console.error("Failed to register slash commands:", e);
  }
}

// -------------------- Discord client --------------------
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

bot.once("ready", async () => {
  console.log(`✅ Logged in as ${bot.user.tag}`);

  // Register slash commands (safe to do on startup)
  await registerSlashCommands();

  // Expire overdue approvals (if bot was offline)
  await expireOverdueApprovalsOnStartup();

  // Re-schedule timers after restart
  try {
    requests = readJson(REQUESTS_PATH, {});
    const now = Date.now();
    for (const [id, r] of Object.entries(requests)) {
      if (isApprovedAndActive(r, now)) {
        scheduleExpiry(id);
      }
    }
  } catch (e) {
    console.error("Failed to reschedule timers:", e);
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
          return interaction.reply({ content: "Admins only.", ephemeral: true });
        }

        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: "Guild only.", ephemeral: true });

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
            ephemeral: true,
          });
        }
        if (!adminRole || !openSeasonRole) {
          return interaction.reply({
            content: "Admin role and Open Season role are required.",
            ephemeral: true,
          });
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
            `✅ Setup complete.\n` +
            `• Rules panel: <#${rulesChannel.id}>\n` +
            `• Apply panel: <#${applyChannel.id}>\n` +
            `• Admin review: <#${adminChannel.id}> (ping <@&${adminRole.id}>)\n` +
            `• Open Season announcements: <#${announceChannel.id}> (ping <@&${openSeasonRole.id}>)\n` +
            `• Rules gate role: <@&${rulesAcceptedRole.id}>`,
          ephemeral: true,
        });
      }

      if (interaction.commandName === "rules") {
        return interaction.reply({
          embeds: [buildRulesEmbed()],
          components: [buildRulesRow()],
          ephemeral: true,
        });
      }

      if (interaction.commandName === "whiteflags" && interaction.options.getSubcommand() === "active") {
        // Admin-only (admin role or Administrator)
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: "Guild only.", ephemeral: true });

        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        const isAdminPerm =
          member?.permissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
        const hasAdminRole = state.adminRoleId ? member?.roles?.cache?.has(state.adminRoleId) : false;

        if (!isAdminPerm && !hasAdminRole) {
          return interaction.reply({ content: "Admins only.", ephemeral: true });
        }

        requests = readJson(REQUESTS_PATH, {});
        const now = Date.now();
        const active = Object.values(requests).filter((r) => isApprovedAndActive(r, now));

        if (active.length === 0) {
          return interaction.reply({ content: "No active White Flags right now.", ephemeral: true });
        }

        // Sort by end time soonest
        active.sort((a, b) => (a.approvedAt + SEVEN_DAYS_MS) - (b.approvedAt + SEVEN_DAYS_MS));

        const lines = active.map((r) => {
          const endsAt = r.approvedAt + SEVEN_DAYS_MS;
          const server = escapeMd(r.serverType || r.cluster || "N/A");
          return `• **${escapeMd(r.tribeName)}** — IGN: **${escapeMd(r.ign)}** — Server: **${server}** — Ends ${fmtDiscordRelativeTime(endsAt)} (ID: \`${r.id}\`)`;
        });

        const embed = new EmbedBuilder()
          .setTitle(`🏳️ Active White Flags (${active.length})`)
          .setDescription(lines.join("\n").slice(0, 3900)); // keep under embed limits

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
    }

    // -------------------- Buttons --------------------
    if (interaction.isButton()) {
      // Rules accept
      if (interaction.customId === CID.RULES_ACCEPT) {
        if (!interaction.guild || !interaction.member) {
          return interaction.reply({ content: "Guild only.", ephemeral: true });
        }
        if (!state.rulesAcceptedRoleId) {
          return interaction.reply({
            content: "Bot not setup yet. Ask an admin to run /setup.",
            ephemeral: true,
          });
        }

        const role = await interaction.guild.roles
          .fetch(state.rulesAcceptedRoleId)
          .catch(() => null);
        if (!role) {
          return interaction.reply({
            content: "Rules role missing. Ask an admin to rerun /setup.",
            ephemeral: true,
          });
        }

        const member = await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null);
        if (!member) return interaction.reply({ content: "Could not fetch member.", ephemeral: true });

        if (member.roles.cache.has(role.id)) {
          return interaction.reply({
            content: "✅ You already accepted the rules. You can apply now.",
            ephemeral: true,
          });
        }

        await member.roles.add(role, "Accepted White Flag rules").catch(() => null);
        return interaction.reply({
          content: "✅ Thanks. You can now submit a White Flag application.",
          ephemeral: true,
        });
      }

      // Apply open -> show modal (only if rules accepted + no pending request)
      if (interaction.customId === CID.APPLY_OPEN_25 || interaction.customId === CID.APPLY_OPEN_100) {
        if (!interaction.guild) {
          return interaction.reply({ content: "Guild only.", ephemeral: true });
        }
        if (!state.rulesAcceptedRoleId || !state.adminChannelId || !state.adminRoleId) {
          return interaction.reply({
            content: "Bot not setup yet. Ask an admin to run /setup.",
            ephemeral: true,
          });
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
            ephemeral: true,
          });
        }

        const member = await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null);
        if (!member) return interaction.reply({ content: "Could not fetch member.", ephemeral: true });

        if (!member.roles.cache.has(state.rulesAcceptedRoleId)) {
          return interaction.reply({
            content: "You must read and accept the White Flag rules before submitting an application.",
            ephemeral: true,
          });
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
        if (!interaction.guild) return interaction.reply({ content: "Guild only.", ephemeral: true });

        // Optional: enforce that admin actions happen inside admin channel
        if (state.adminChannelId && interaction.channelId !== state.adminChannelId) {
          return interaction.reply({
            content: "Admin actions must be used in the admin review channel.",
            ephemeral: true,
          });
        }

        // Permission check: must have admin role OR Administrator permission
        const member = await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null);
        const isAdminPerm =
          member?.permissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
        const hasAdminRole = state.adminRoleId ? member?.roles?.cache?.has(state.adminRoleId) : false;

        if (!isAdminPerm && !hasAdminRole) {
          return interaction.reply({ content: "Admins only.", ephemeral: true });
        }

        const requestId = interaction.customId.split(":")[1];
        requests = readJson(REQUESTS_PATH, {});
        const req = requests[requestId];
        if (!req) {
          return interaction.reply({ content: "Request not found (maybe already handled).", ephemeral: true });
        }

        // Approve
        if (interaction.customId.startsWith(CID.ADMIN_APPROVE_PREFIX)) {
          if (req.status !== "pending") {
            return interaction.reply({ content: `Already ${req.status}.`, ephemeral: true });
          }

          // Enforce one active White Flag per tribe
          const existingActive = getActiveApprovedForTribe(req.tribeName, requestId);
          if (existingActive) {
            return interaction.reply({
              content:
                `❌ Cannot approve. Tribe **${escapeMd(req.tribeName)}** already has an active White Flag ` +
                `(ID: \`${existingActive.id}\`) ending ${fmtDiscordRelativeTime(existingActive.approvedAt + SEVEN_DAYS_MS)}.`,
              ephemeral: true,
            });
          }

          req.status = "approved";
          req.approvedAt = Date.now();
          req.approvedBy = interaction.user.id;
          requests[requestId] = req;
          persist();

          scheduleExpiry(requestId);

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
                `✅ Your White Flag request for **${req.tribeName}** (${req.serverType || req.cluster || "Server"}) was approved. Protection lasts 7 days from approval.`
              )
              .catch(() => null);
          }

          return;
        }

        // Deny
        if (interaction.customId.startsWith(CID.ADMIN_DENY_PREFIX)) {
          if (req.status !== "pending") {
            return interaction.reply({ content: `Already ${req.status}.`, ephemeral: true });
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
                `❌ Your White Flag request for **${req.tribeName}** (${req.serverType || req.cluster || "Server"}) was denied. If you think this is a mistake, contact an admin.`
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
              ephemeral: true,
            });
          }

          // Cancel timer
          const t = activeTimeouts.get(requestId);
          if (t) clearTimeout(t);
          activeTimeouts.delete(requestId);

          req.status = "ended_early";
          req.endedEarlyAt = Date.now();
          req.endedEarlyBy = interaction.user.id;
          requests[requestId] = req;
          persist();

          // Announce Open Season (ping role)
          const announceCh = await interaction.guild.channels
            .fetch(state.announceChannelId)
            .catch(() => null);

          if (announceCh && isTextChannel(announceCh)) {
            await announceCh.send(
              `<@&${state.openSeasonRoleId}> 🚨 **OPEN SEASON** — White Flag ended early for **${escapeMd(
                req.tribeName
              )}** (IGN: **${escapeMd(req.ign)}**, Server: **${escapeMd(
                req.serverType || req.cluster || "N/A"
              )}**). A bounty may be placed.`
            );
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
                `🚨 An admin ended your White Flag early for **${req.tribeName}** (${req.serverType || req.cluster || "Server"}). Your tribe is now OPEN SEASON.`
              )
              .catch(() => null);
          }

          return;
        }
      }
    }

    // -------------------- Modal submit --------------------
    if (interaction.type === InteractionType.ModalSubmit) {
      const is25 = interaction.customId === CID.APPLY_MODAL_25;
      const is100 = interaction.customId === CID.APPLY_MODAL_100;
      if (!is25 && !is100) return;
      if (!interaction.guild) return interaction.reply({ content: "Guild only.", ephemeral: true });

      if (!state.adminChannelId || !state.adminRoleId) {
        return interaction.reply({
          content: "Bot not setup yet. Ask an admin to run /setup.",
          ephemeral: true,
        });
      }

      const serverType = is25 ? "25x PVP" : "100x PVP Chaos";

      // Re-check rules role gate
      const member = await interaction.guild.members
        .fetch(interaction.user.id)
        .catch(() => null);
      if (!member || !member.roles.cache.has(state.rulesAcceptedRoleId)) {
        return interaction.reply({
          content: "You must accept the rules before submitting an application.",
          ephemeral: true,
        });
      }

      const ign = interaction.fields.getTextInputValue("ign")?.trim();
      const tribe = interaction.fields.getTextInputValue("tribe")?.trim();
      const map = interaction.fields.getTextInputValue("map")?.trim();

      if (!ign || !tribe || !map) {
        return interaction.reply({ content: "All fields are required.", ephemeral: true });
      }

      // Prevent duplicate pending requests (race-safe-ish)
      requests = readJson(REQUESTS_PATH, {});
      const pending = getPendingRequestForUser(interaction.user.id);
      if (pending) {
        return interaction.reply({
          content: "You already have a pending White Flag application. Please wait for admin review.",
          ephemeral: true,
        });
      }

      // Enforce one active White Flag per tribe (block submission too)
      const existingActive = getActiveApprovedForTribe(tribe);
      if (existingActive) {
        return interaction.reply({
          content:
            `❌ That tribe already has an active White Flag (ID: \`${existingActive.id}\`) ` +
            `ending ${fmtDiscordRelativeTime(existingActive.approvedAt + SEVEN_DAYS_MS)}.`,
          ephemeral: true,
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
          ephemeral: true,
        });
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
        content: `✅ Submitted for **${serverType}**! Admins have been notified.`,
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error("interaction error:", err);
    if (interaction && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: "Something went wrong.", ephemeral: true });
      } catch {}
    }
  }
});

bot.login(TOKEN);
