// commands.js
// Slash command deploy script for the White Flag bot (Discord.js v14).
//
// Use this if you prefer registering commands separately from index.js.
//
// Env:
//   DISCORD_TOKEN (required)
//   CLIENT_ID    (required) - your application's client id
//   GUILD_ID     (optional) - if set, registers to that guild instantly; otherwise registers globally
//
// Run:
//   node commands.js
//
// Notes:
// - Global command updates can take up to ~1 hour to appear in Discord.
// - /setup is still guarded in the bot code to require Administrator.

require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;

if (!TOKEN || !CLIENT_ID) {
  console.error("Missing env vars. Need DISCORD_TOKEN and CLIENT_ID. (GUILD_ID is optional)");
  process.exit(1);
}

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
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("Registering slash commands...");

    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`✅ Commands registered to guild ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("✅ Commands registered globally (can take up to ~1 hour to appear).");
    }
  } catch (err) {
    console.error("❌ Failed to register commands:", err);
    process.exit(1);
  }
})();
