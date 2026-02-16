// commands.js
// Slash command deploy script for the White Flag bot (Discord.js v14).
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
    .addChannelOption((opt) =>
      opt
        .setName("bounty_channel")
        .setDescription("Channel to announce bounties (optional)")
        .setRequired(false)
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

  new SlashCommandBuilder().setName("rules").setDescription("Show the White Flag rules (ephemeral)."),

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
        .setDescription("Submit a bounty claim (admin review).")
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
          opt.setName("proof").setDescription("Proof link (clip/screenshot)").setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("notes").setDescription("Optional notes for admins").setRequired(false)
        )
    ),

  new SlashCommandBuilder()
    .setName("bounties")
    .setDescription("Bounty utilities.")
    .addSubcommand((sc) => sc.setName("active").setDescription("Show all active bounties.")),

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