require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const fs = require("fs");
const path = require("path");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const WHITEFLAGS_FILE = path.join(__dirname, "whiteflags.json");
const SETTINGS_FILE = path.join(__dirname, "settings.json");

// ================= JSON helpers =================
function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function loadWhiteflags() {
  return loadJson(WHITEFLAGS_FILE, []);
}
function saveWhiteflags(items) {
  saveJson(WHITEFLAGS_FILE, items);
}

function loadSettings() {
  // { [guildId]: { openSeasonChannelId, modLogChannelId, role100xId, role25xId } }
  return loadJson(SETTINGS_FILE, {});
}
function saveSettings(s) {
  saveJson(SETTINGS_FILE, s);
}
function getGuildSettings(guildId) {
  const all = loadSettings();
  return all[guildId] || null;
}

// ================= Time / prune =================
function nowMs() {
  return Date.now();
}
function pruneExpired(items) {
  const t = nowMs();
  const active = items.filter(x => x.expiresAt > t);
  if (active.length !== items.length) saveWhiteflags(active);
  return active;
}

// ================= Cluster constants =================
const CLUSTER_100X = "PVP Chaos 100x";
const CLUSTER_25X = "PVP 25X";

function normalizeClusterKey(key) {
  const k = (key || "").toLowerCase().trim();
  if (k === "100x") return "100x";
  if (k === "25x") return "25x";
  return "";
}

function clusterFromKey(key) {
  const k = normalizeClusterKey(key);
  if (k === "100x") return CLUSTER_100X;
  if (k === "25x") return CLUSTER_25X;
  return "";
}

// ================= Role mention helper (exact) =================
function getClusterRoleMention(guildId, clusterRaw) {
  const s = getGuildSettings(guildId);
  if (!s) return "";

  const c = (clusterRaw || "").trim().toLowerCase();

  if (c === CLUSTER_100X.toLowerCase()) return s.role100xId ? `<@&${s.role100xId}>` : "";
  if (c === CLUSTER_25X.toLowerCase()) return s.role25xId ? `<@&${s.role25xId}>` : "";

  return "";
}

// ================= Modal builder (cluster locked) =================
function buildWhiteflagModal(clusterKey) {
  const cluster = clusterFromKey(clusterKey);
  if (!cluster) return null;

  const modal = new ModalBuilder()
    .setCustomId(`whiteflag_register_modal:${normalizeClusterKey(clusterKey)}`)
    .setTitle(`White Flag Registration — ${cluster}`);

  const tribe = new TextInputBuilder()
    .setCustomId("tribe")
    .setLabel("Tribe Name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const ign = new TextInputBuilder()
    .setCustomId("ign")
    .setLabel("In-Game Name (IGN)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const mapcoords = new TextInputBuilder()
    .setCustomId("mapcoords")
    .setLabel("Map & Coords (example: Island 50,50)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const notes = new TextInputBuilder()
    .setCustomId("notes")
    .setLabel("Notes (optional)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(tribe),
    new ActionRowBuilder().addComponents(ign),
    new ActionRowBuilder().addComponents(mapcoords),
    new ActionRowBuilder().addComponents(notes)
  );

  return modal;
}

// ================= Log helpers =================
async function sendModLog(guild, embed) {
  const settings = getGuildSettings(guild.id);
  if (!settings?.modLogChannelId) return;

  const ch = await guild.channels.fetch(settings.modLogChannelId).catch(() => null);
  if (!ch) return;

  await ch.send({ embeds: [embed], allowedMentions: { parse: ["roles"] } }).catch(() => null);
}

async function sendOpenSeason(guild, tribe, cluster, reason) {
  const settings = getGuildSettings(guild.id);
  if (!settings?.openSeasonChannelId) return;

  const ch = await guild.channels.fetch(settings.openSeasonChannelId).catch(() => null);
  if (!ch) return;

  const ping = getClusterRoleMention(guild.id, cluster);

  const text =
    `${ping ? ping + "\n" : ""}` +
    `🚨 **OPEN SEASON** 🚨\n` +
    `White Flag has been removed for **${tribe}** on **${cluster}**.\n` +
    (reason ? `Reason: **${reason}**\n` : "") +
    `Raids are now allowed.`;

  await ch.send({ content: text, allowedMentions: { parse: ["roles"] } }).catch(() => null);
}

client.once("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  pruneExpired(loadWhiteflags());
});

client.on("interactionCreate", async (interaction) => {
  // ================= Button click -> open modal =================
  if (interaction.isButton() && interaction.customId.startsWith("whiteflag_button:")) {
    const clusterKey = interaction.customId.split(":")[1];
    const modal = buildWhiteflagModal(clusterKey);
    if (!modal) {
      return interaction.reply({ content: "❌ Invalid cluster button.", ephemeral: true });
    }
    await interaction.showModal(modal);
    return;
  }

  // ================= Modal submit =================
  if (interaction.isModalSubmit() && interaction.customId.startsWith("whiteflag_register_modal:")) {
    const clusterKey = interaction.customId.split(":")[1];
    const cluster = clusterFromKey(clusterKey);
    if (!cluster) {
      return interaction.reply({ content: "❌ Invalid cluster form.", ephemeral: true });
    }

    const tribe = interaction.fields.getTextInputValue("tribe");
    const ign = interaction.fields.getTextInputValue("ign");
    const mapcoords = interaction.fields.getTextInputValue("mapcoords");
    const notes = interaction.fields.getTextInputValue("notes") || "";

    let items = pruneExpired(loadWhiteflags());

    const exists = items.find(
      x => x.tribe.toLowerCase() === tribe.toLowerCase() && x.cluster.toLowerCase() === cluster.toLowerCase()
    );
    if (exists) {
      return interaction.reply({
        content: `⚠️ **${tribe}** already has an active White Flag on **${cluster}**.`,
        ephemeral: true,
      });
    }

    const createdAt = nowMs();
    const expiresAt = createdAt + 7 * 24 * 60 * 60 * 1000;

    items.push({
      tribe,
      cluster,
      ign,
      mapcoords,
      notes,
      createdBy: interaction.user.tag,
      createdAt,
      expiresAt,
    });

    saveWhiteflags(items);

    const embed = new EmbedBuilder()
      .setTitle("✅ White Flag Activated")
      .addFields(
        { name: "Tribe", value: tribe, inline: true },
        { name: "Cluster", value: cluster, inline: true },
        { name: "IGN", value: ign, inline: true },
        { name: "Map / Coords", value: mapcoords, inline: false },
        { name: "Expires", value: `<t:${Math.floor(expiresAt / 1000)}:F>`, inline: false },
        { name: "Notes", value: notes || "None", inline: false }
      );

    await interaction.reply({ embeds: [embed] });

    const ping = getClusterRoleMention(interaction.guild.id, cluster);
    if (ping) {
      await interaction.channel.send({
        content: `${ping} New White Flag registration: **${tribe}** (${cluster})`,
        allowedMentions: { parse: ["roles"] },
      });
    }

    const logEmbed = new EmbedBuilder()
      .setTitle("📝 White Flag Registered")
      .setDescription(`Registered by **${interaction.user.tag}**`)
      .addFields(
        { name: "Tribe", value: tribe, inline: true },
        { name: "Cluster", value: cluster, inline: true },
        { name: "Expires", value: `<t:${Math.floor(expiresAt / 1000)}:F>`, inline: false }
      );

    await sendModLog(interaction.guild, logEmbed);
    return;
  }

  // ================= Slash commands =================
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;
  const guild = interaction.guild;

  const isAdmin =
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

  if (cmd === "setup") {
    if (!isAdmin) return interaction.reply({ content: "❌ No permission.", ephemeral: true });

    const openSeasonChannel = interaction.options.getChannel("open_season_channel", true);
    const modLogChannel = interaction.options.getChannel("mod_log_channel", true);

    const all = loadSettings();
    all[guild.id] = {
      ...(all[guild.id] || {}),
      openSeasonChannelId: openSeasonChannel.id,
      modLogChannelId: modLogChannel.id,
    };
    saveSettings(all);

    const embed = new EmbedBuilder()
      .setTitle("✅ Setup Saved")
      .addFields(
        { name: "Open Season Channel", value: `<#${openSeasonChannel.id}>`, inline: false },
        { name: "Mod Log Channel", value: `<#${modLogChannel.id}>`, inline: false }
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (cmd === "setup_roles") {
    if (!isAdmin) return interaction.reply({ content: "❌ No permission.", ephemeral: true });

    const role100x = interaction.options.getRole("role_100x", true);
    const role25x = interaction.options.getRole("role_25x", true);

    const all = loadSettings();
    all[guild.id] = {
      ...(all[guild.id] || {}),
      role100xId: role100x.id,
      role25xId: role25x.id,
    };
    saveSettings(all);

    const embed = new EmbedBuilder()
      .setTitle("✅ Role Ping Setup Saved")
      .addFields(
        { name: "PVP Chaos 100x Role", value: `<@&${role100x.id}>`, inline: false },
        { name: "PVP 25X Role", value: `<@&${role25x.id}>`, inline: false }
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (cmd === "post_whiteflag_buttons") {
    if (!isAdmin) return interaction.reply({ content: "❌ No permission.", ephemeral: true });

    const embed = new EmbedBuilder()
      .setTitle("🟢 White Flag Registration")
      .setDescription("Choose your cluster, then fill out the form.");

    const b100 = new ButtonBuilder()
      .setCustomId("whiteflag_button:100x")
      .setLabel(CLUSTER_100X)
      .setStyle(ButtonStyle.Success);

    const b25 = new ButtonBuilder()
      .setCustomId("whiteflag_button:25x")
      .setLabel(CLUSTER_25X)
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(b100, b25);

    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: "✅ Buttons posted.", ephemeral: true });
    return;
  }

  if (cmd === "rules") {
    const rulesText =
      "**🟢 White Flag System**\n" +
      "- White Flag gives new players **7 days** to build up.\n" +
      "- **You are NOT allowed to raid while your White Flag is up.**\n" +
      "- Raiding during White Flag = immediate removal + open season announcement.\n";

    const embed = new EmbedBuilder().setTitle("White Flag Rules").setDescription(rulesText);
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (cmd === "whiteflag_list") {
    const items = pruneExpired(loadWhiteflags());

    if (!items.length) {
      return interaction.reply({ content: "No active White Flags.", ephemeral: true });
    }

    const lines = items
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .map(x => `• **${x.tribe}** (${x.cluster}) — expires <t:${Math.floor(x.expiresAt / 1000)}:R>`)
      .join("\n");

    const embed = new EmbedBuilder().setTitle("Active White Flags").setDescription(lines);
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (cmd === "whiteflag_end") {
    if (!isAdmin) return interaction.reply({ content: "❌ No permission.", ephemeral: true });

    const tribeInput = interaction.options.getString("tribe", true);
    const reason = interaction.options.getString("reason") || "";

    let items = pruneExpired(loadWhiteflags());
    const toEnd = items.find(x => x.tribe.toLowerCase() === tribeInput.toLowerCase());

    if (!toEnd) {
      return interaction.reply({
        content: `Could not find an active White Flag for **${tribeInput}**.`,
        ephemeral: true,
      });
    }

    items = items.filter(x => x !== toEnd);
    saveWhiteflags(items);

    await interaction.reply({
      content: `✅ Ended White Flag early for **${toEnd.tribe}**.`,
      ephemeral: true,
    });

    await sendOpenSeason(guild, toEnd.tribe, toEnd.cluster, reason);

    const logEmbed = new EmbedBuilder()
      .setTitle("🚫 White Flag Ended Early")
      .setDescription(`Ended by **${interaction.user.tag}**`)
      .addFields(
        { name: "Tribe", value: toEnd.tribe, inline: true },
        { name: "Cluster", value: toEnd.cluster, inline: true },
        { name: "Reason", value: reason || "None", inline: false }
      );

    await sendModLog(guild, logEmbed);
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
