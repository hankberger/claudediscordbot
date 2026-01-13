import "dotenv/config";
import express, { text } from "express";
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from "discord-interactions";
import OpenAI from "openai";
const client = new OpenAI();
import {
  connectToGateway,
  joinVoiceChannel,
  leaveVoiceChannel,
} from "./gateway.js";

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 5000;
// To keep track of our active games
const activeGames = {};

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post(
  "/interactions",
  verifyKeyMiddleware(process.env.PUBLIC_KEY),
  async function (req, res) {
    // Interaction id, type and data
    const { id, type, data, guild_ID } = req.body;

    /**
     * Handle verification requests
     */
    if (type === InteractionType.PING) {
      return res.send({ type: InteractionResponseType.PONG });
    }

    /**
     * Handle slash command requests
     * See https://discord.com/developers/docs/interactions/application-commands#slash-commands
     */
    if (type === InteractionType.APPLICATION_COMMAND) {
      const { name } = data;

      // "test" command
      if (name === "test") {
        // Send a message into the channel where command was triggered from
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [
              {
                type: 17, // ComponentType.CONTAINER
                components: [
                  {
                    type: 10, // ComponentType.TEXT_DISPLAY
                    content: "# Real Game v7.3",
                  },
                  {
                    type: 1, // ComponentType.ACTION_ROW
                    components: [
                      {
                        type: 2, // ComponentType.BUTTON
                        style: 1, // ButtonStyle.PRIMARY
                        label: "Submit Feedback",
                        custom_id: "open_feedback_modal",
                      },
                      {
                        type: 2, // ComponentType.BUTTON
                        style: 2, // ButtonStyle.PRIMARY
                        label: "Join Voice",
                        custom_id: "test_voice",
                      },
                      {
                        type: 2, // ComponentType.BUTTON
                        style: 2, // ButtonStyle.PRIMARY
                        label: "Leave Voice",
                        custom_id: "leave_voice",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        });
      }

      console.error(`unknown command: ${name}`);
      return res.status(400).json({ error: "unknown command" });
    }

    if (type === InteractionType.MESSAGE_COMPONENT) {
      const { custom_id } = data;
      console.log(data);

      if (custom_id === "test_voice") {
        const { user } = req.body.member;
        const { guild_id } = req.body;

        const response = await fetch(
          `https://discord.com/api/v10/guilds/${guild_id}/voice-states/${user.id}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (response.ok) {
          const voiceState = await response.json();
          console.log("User voice state:", voiceState);
          console.log("User is in channel:", voiceState.channel_id);
          //TODO: Probably move these next 2 lines to their own instance
          await connectToGateway();
          joinVoiceChannel(guild_id, voiceState.channel_id);
        } else if (response.status === 404) {
          console.log("User is not in a voice channel");
        } else {
          console.log("Error:", response.status, await response.text());
        }
      }

      if (custom_id === "leave_voice") {
        const { guild_id } = req.body;

        leaveVoiceChannel(guild_id);
      }

      // "test" command
      if (custom_id === "open_feedback_modal") {
        // Send a message into the channel where command was triggered from
        // When you receive an interaction with custom_id === "open_feedback_modal"
        return res.send({
          type: InteractionResponseType.MODAL,
          data: {
            custom_id: "feedback_modal_submit",
            title: "Real Game v7.3",
            components: [
              {
                type: 1, // ComponentType.ACTION_ROW
                components: [
                  {
                    type: 4, // ComponentType.TEXT_INPUT
                    style: 1, // 1 = short, 2 = paragraph
                    custom_id: "feedback_text",
                    label: "Your feedback",
                    placeholder: "Type something here...",
                    required: true,
                  },
                ],
              },
            ],
          },
        });
      }

      console.error(`unknown command: ${custom_id}`);
      return res.status(400).json({ error: "unknown command" });
    }

    if (type === InteractionType.MODAL_SUBMIT) {
      const { custom_id, components } = data;
      const { value } = components[0].components[0];
      console.log(components[0].components[0].value);

      const stream = await client.responses.create({
        model: "gpt-5",
        input: [
          {
            role: "user",
            content: "Say 'double bubble bath' ten times fast.",
          },
        ],
        stream: true,
      });

      for await (const event of stream) {
        if (event.type == "response.output_text.delta") {
          console.log(event.delta);
        }
      }

      // "test" command
      if (custom_id == "feedback_modal_submit") {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [
              {
                type: 17, // ComponentType.CONTAINER
                components: [
                  {
                    type: 10, // ComponentType.TEXT_DISPLAY
                    content: "YO YOY O",
                  },
                ],
              },
            ],
          },
        });
      }

      console.error(`unknown command: ${custom_id}`);
      return res.status(400).json({ error: "unknown command" });
    }

    console.error("unknown interaction type", type);
    return res.status(400).json({ error: "unknown interaction type" });
  }
);

app.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
