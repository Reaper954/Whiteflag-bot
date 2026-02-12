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

// ----------------- JSON helpers -----------------
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

// ----------------- time / prune -----------------
function nowMs() {
  return Date.now();
}
function pruneExpired(items) {
  const t = nowMs();
  const active = items.filter(x => x.expiresAt > t);
  if (active.length !== items.length) saveWhiteflags(active);
  return active;
}

// ----------------- role mention helper -----------------
function getClusterRoleMention(guildId, clusterRaw) {
  const s = getGuildSettings(guildId);
  if (!s) return "";

  const cluster = (clusterRaw || "").toLowerCase();

  if (cluster.includes("100")) return s.role100xId ? `<@&${s.role100xId}>` : "";
  if (cluster.includes("25")) return s.role25xId ? `<@&${s.role25xId}>` : "";

  return "";
}

// ----------------- modal builder -----------------
function buildWhiteflagModal() {
  const modal = new ModalBuilder()
    .setCustomId("whiteflag_register_modal")
    .setTitle("White Flag Registration");

  const tribe = new TextInputBuilder()
    .setCustomId("tribe")
    .setLabel("Tribe Name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const cluster = new TextInputBuilder()
    .setCustomId("cluster")
    .setLabel("Cluster (100x / 25x)")
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
    new ActionRowBuilder().addComponents(cluster),
    new ActionRowBuilder().addComponents(ign),
    new ActionRowBuilder().addComponents(mapcoords),
    new ActionRowBuilder().addComponents(notes)
  );

  return modal;
}

// ----------------- log helpers -----------------
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
  // ----------------- Button click -> open modal -----------------
  if (interaction.isButton() && interaction.customId === "whiteflag_button") {
    const modal = buildWhiteflagModal();
    await interaction.showModal(modal);
    return;
  }

  // ----------------- Modal submit -> save + ping + log -----------------
  if (interaction.isModalSubmit() && interaction.customId === "whiteflag_register_modal") {
    const tribe = interaction.fields.getTextInputValue("tribe");
    const cluster = interaction.fields.getTextInputValue("cluster");
    const ign = interaction.fields.getTextInputValue("ign");
    const mapcoords = interaction.fields.getTextInputValue("mapcoords");
    const notes = interaction.fields.getTextInputValue("notes") || "";

    let items = pruneExpired(loadWhiteflags());

    const exists = items.find(
      x =>
        x.tribe.toLowerCase() === tribe.toLowerCase() &&
        x.cluster.toLowerCase() === cluster.toLowerCase()
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

  // ----------------- Slash commands -----------------
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
        { name: "100x Role", value: `<@&${role100x.id}>`, inline: false },
        { name: "25x Role", value: `<@&${role25x.id}>`, inline: false }
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (cmd === "post_whiteflag_button") {
    if (!isAdmin) return interaction.reply({ content: "❌ No permission.", ephemeral: true });

    const embed = new EmbedBuilder()
      .setTitle("🟢 White Flag Registration")
      .setDescription("Click the button below to register your tribe for White Flag protection.");

    const button = new ButtonBuilder()
      .setCustomId("whiteflag_button")
      .setLabel("Register White Flag")
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(button);

    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: "✅ Button posted.", ephemeral: true });
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
