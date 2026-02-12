const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
require("dotenv").config();

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure channels for Open Season + Mod Logs")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o =>
      o.setName("open_season_channel")
        .setDescription("Where Open Season announcements go")
        .setRequired(true)
    )
    .addChannelOption(o =>
      o.setName("mod_log_channel")
        .setDescription("Where mod logs go")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("setup_roles")
    .setDescription("Set staff roles to ping per cluster")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption(o =>
      o.setName("role_100x")
        .setDescription("Role to ping for PVP Chaos 100x")
        .setRequired(true)
    )
    .addRoleOption(o =>
      o.setName("role_25x")
        .setDescription("Role to ping for PVP 25X")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("post_whiteflag_buttons")
    .setDescription("Post White Flag registration buttons (100x + 25x)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("rules")
    .setDescription("Post the White Flag rules"),

  new SlashCommandBuilder()
    .setName("whiteflag_list")
    .setDescription("List active White Flags"),

  new SlashCommandBuilder()
    .setName("whiteflag_end")
    .setDescription("End a tribe's White Flag early")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o.setName("tribe")
        .setDescription("Tribe name")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("reason")
        .setDescription("Reason (optional)")
        .setRequired(false)
    ),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("✅ Commands registered.");
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
})();
