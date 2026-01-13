import dotenv from "dotenv";
import { Client, Events, GatewayIntentBits, type Snowflake } from "discord.js";
import { interactionHandlers } from "./util/interactions.js";
import { generateDependencyReport } from "@discordjs/voice";

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
});

/**
 * The ids of the users that can be recorded by the bot.
 */
const recordable = new Set<Snowflake>();

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inCachedGuild() || !interaction.isChatInputCommand()) return;

  const handleInteraction = interactionHandlers.get(interaction.commandName);

  try {
    if (!handleInteraction) {
      await interaction.reply("Unknown command");

      return;
    }

    await handleInteraction(interaction, recordable);
  } catch (error) {
    console.warn(error);
  }
});

client.on(Events.Error, console.error);
console.log(generateDependencyReport());

await client.login(process.env.DISCORD_TOKEN);
