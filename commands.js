// commands.js — Register slash commands for EXODUS OVERSEER (Discord.js v14)
//
// Env:
//   DISCORD_TOKEN (required)
//   CLIENT_ID    (required)
//   GUILD_ID     (optional) - if set, registers instantly to that guild
//
// Run: node commands.js

require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;

if (!TOKEN || !CLIENT_ID) {
  console.error("Missing DISCORD_TOKEN or CLIENT_ID.");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Post rules + apply panels and configure channels/roles for White Flag.")
    .addChannelOption((o) => o.setName("rules_channel").setDescription("Rules channel").setRequired(true))
    .addChannelOption((o) => o.setName("apply_channel").setDescription("Apply channel").setRequired(true))
    .addChannelOption((o) => o.setName("admin_channel").setDescription("Admin review channel").setRequired(true))
    .addChannelOption((o) => o.setName("announce_channel").setDescription("Announcements channel").setRequired(true))
    .addChannelOption((o) => o.setName("bounty_channel").setDescription("Bounty channel (optional)").setRequired(false))
    .addRoleOption((o) => o.setName("admin_role").setDescription("Admin role").setRequired(true))
    .addRoleOption((o) => o.setName("open_season_role").setDescription("Open Season role").setRequired(true)),

  new SlashCommandBuilder().setName("rules").setDescription("Show the White Flag rules (ephemeral)."),

  new SlashCommandBuilder()
    .setName("whiteflags")
    .setDescription("White Flag utilities.")
    .addSubcommand((sc) => sc.setName("active").setDescription("Show all approved and active White Flags.")),

  new SlashCommandBuilder()
    .setName("bounties")
    .setDescription("Bounty utilities.")
    .addSubcommand((sc) => sc.setName("active").setDescription("Show all active bounties.")),

  new SlashCommandBuilder()
    .setName("bounty")
    .setDescription("Create, remove, claim, or check bounties.")
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
        .setDescription("Remove an active bounty by tribe or by ID.")
        .addStringOption((opt) => opt.setName("tribe").setDescription("Tribe name").setRequired(false))
        .addStringOption((opt) => opt.setName("id").setDescription("Bounty record ID").setRequired(false))
    )
    .addSubcommand((sc) =>
      sc
        .setName("claim")
        .setDescription("Submit a bounty claim (admin review).")
        .addStringOption((opt) => opt.setName("tribe").setDescription("Bounty target tribe").setRequired(true))
        .addStringOption((opt) => opt.setName("ign").setDescription("Your IGN").setRequired(true))
        .addStringOption((opt) => opt.setName("bounty_ign").setDescription("Bounty target IGN").setRequired(true))
        .addStringOption((opt) => opt.setName("proof").setDescription("Proof link/text").setRequired(true))
        .addStringOption((opt) => opt.setName("notes").setDescription("Optional notes").setRequired(false))
    )
    .addSubcommand((sc) =>
      sc
        .setName("status")
        .setDescription("Check bounty status by tribe or id")
        .addStringOption((o) => o.setName("tribe").setDescription("Tribe name").setRequired(false))
        .addStringOption((o) => o.setName("id").setDescription("Record id").setRequired(false))
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
            .addChoices(
              { name: "pending", value: "pending" },
              { name: "approved", value: "approved" },
              { name: "denied", value: "denied" },
              { name: "all", value: "all" }
            )
        )
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`✅ Commands registered to guild ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("✅ Commands registered globally (can take up to ~1 hour to appear).");
    }
  } catch (e) {
    console.error("❌ Failed to register commands:", e);
    process.exit(1);
  }
})();
