import {
  ApplicationCommandOptionType,
  REST,
  Routes,
  type RESTPutAPIApplicationCommandsResult,
  type RESTPutAPIApplicationCommandsJSONBody,
} from "discord.js";
import dotenv from "dotenv";
dotenv.config();

const COMMANDS: RESTPutAPIApplicationCommandsJSONBody = [
  {
    name: "join",
    description: "Joins the voice channel that you are in",
  },
  {
    name: "record",
    description: "Enables recording for a user",
    options: [
      {
        name: "speaker",
        type: ApplicationCommandOptionType.User,
        description: "The user to record",
        required: true,
      },
    ],
  },
  {
    name: "leave",
    description: "Leave the voice channel",
  },
];

const rest = new REST().setToken(process.env.DISCORD_TOKEN!);

const result = (await rest.put(
  Routes.applicationCommands(process.env.APP_ID!),
  {
    body: COMMANDS,
  }
)) as RESTPutAPIApplicationCommandsResult;

console.log(`Successfully deployed ${result.length} commands.`);
