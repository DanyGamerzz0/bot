import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
} from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_CHANNEL_IDS = new Set(
  (process.env.CHANNEL_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

if (ALLOWED_CHANNEL_IDS.size === 0) {
  throw new Error("Missing CHANNEL_IDS environment variable.");
}

if (!DISCORD_TOKEN) {
  throw new Error("Missing DISCORD_TOKEN environment variable.");
}

if (!CHANNEL_ID) {
  throw new Error("Missing CHANNEL_ID environment variable.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Monitoring channel ${CHANNEL_ID} and all threads under it.`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

const isAllowedChannel = ALLOWED_CHANNEL_IDS.has(message.channel.id);

const isThreadInAllowedChannel =
  message.channel.isThread() &&
  ALLOWED_CHANNEL_IDS.has(message.channel.parentId);

if (!isAllowedChannel && !isThreadInAllowedChannel) return;

  const jsonAttachments = message.attachments.filter((attachment) =>
    attachment.name?.toLowerCase().endsWith(".json")
  );

  if (jsonAttachments.size === 0) return;

  for (const attachment of jsonAttachments.values()) {
    try {
      const response = await fetch(attachment.url);

      if (!response.ok) {
        throw new Error(
          `Failed to download attachment: HTTP ${response.status}`
        );
      }

      const jsonText = await response.text();
      const macroInfo = parseMacro(jsonText);

      if (!macroInfo) {
        await message.reply({
          content:
            "This is not a valid macro file. The file must contain a non-empty array of actions.",
          allowedMentions: {
            repliedUser: false,
          },
        });

        continue;
      }

      const embed = buildEmbed(attachment.url, macroInfo);

      await message.reply({
        embeds: [embed],
        allowedMentions: {
          repliedUser: false,
        },
      });
      if (message.channel.isThread()) {
      await pinThreadStarter(message.channel);
    }
    } catch (error) {
      console.error("Error processing macro file:", error);

      await message
        .reply({
          content: "Something went wrong while processing the macro.",
          allowedMentions: {
            repliedUser: false,
          },
        })
        .catch(() => {});
    }
  }
});

function parseMacro(jsonText) {
  try {
    const actions = JSON.parse(jsonText);

    if (!Array.isArray(actions) || actions.length === 0) {
      return null;
    }

    const validActions = actions.filter(
      (action) =>
        action &&
        typeof action === "object" &&
        typeof action.Type === "string"
    );

    if (validActions.length === 0) {
      return null;
    }

    const units = new Set();

    for (const action of validActions) {
      const actionType = action.Type.trim().toLowerCase();

      if (
        actionType === "place" &&
        typeof action.Label === "string" &&
        action.Label.trim()
      ) {
        const unitName = cleanUnitName(action.Label);

        if (unitName) {
          units.add(unitName);
        }
      }
    }

    return {
      totalSteps: actions.length,
      units: units.size > 0 ? [...units].join(", ") : "None detected",
    };
  } catch {
    return null;
  }
}

function cleanUnitName(label) {
  return label
    .replace(/ #\d+$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildEmbed(url, macroInfo) {
  return new EmbedBuilder()
    .setTitle("Macro Formatter")
    .addFields(
      {
        name: "Total actions",
        value: String(macroInfo.totalSteps),
        inline: true,
      },
      {
        name: "Required units",
        value: macroInfo.units,
        inline: true,
      },
      {
        name: "URL",
        value: [
          "```text",
          url,
          "```",
          "**For Mobile Users:**",
          `[Download Macro](${url})`,
        ].join("\n"),
        inline: false,
      }
    );
}
async function pinThreadStarter(thread) {
  try {
    const starterMessage = await thread.fetchStarterMessage();

    if (!starterMessage) return;

    const pinnedMessages = await thread.messages.fetchPinned();

    if (pinnedMessages.has(starterMessage.id)) return;

    await starterMessage.pin();
  } catch (error) {
    console.warn(
      `Could not pin the thread starter in ${thread.id}:`,
      error.message
    );
  }
}
client.login(DISCORD_TOKEN);
