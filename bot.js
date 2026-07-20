import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  SlashCommandBuilder,
} from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const ALLOWED_CHANNEL_IDS = new Set(
  (process.env.CHANNEL_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

if (!DISCORD_TOKEN) {
  throw new Error("Missing DISCORD_TOKEN environment variable.");
}

if (ALLOWED_CHANNEL_IDS.size === 0) {
  throw new Error("Missing CHANNEL_IDS environment variable.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const uploadCommand = new SlashCommandBuilder()
  .setName("upload")
  .setDescription("Upload and format a macro file")
  .addAttachmentOption((option) =>
    option
      .setName("file")
      .setDescription("The macro JSON file")
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName("note")
      .setDescription("Optional note to display with the macro")
      .setMaxLength(1000)
      .setRequired(false)
  );

client.once("clientReady", async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(
    `Monitoring ${ALLOWED_CHANNEL_IDS.size} allowed channel(s) and their threads.`
  );

  try {
    const commandData = [uploadCommand.toJSON()];

    await readyClient.application.commands.set([]);

    for (const guild of readyClient.guilds.cache.values()) {
      const commands = await guild.commands.set(commandData);

      console.log(
        `Registered commands in ${guild.name}:`,
        commands.map((command) => ({
          name: command.name,
          description: command.description,
          options: command.options.map((option) => option.name),
        }))
      );
    }
  } catch (error) {
    console.error("Could not register slash command:", error);
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!isAllowedLocation(message.channel)) return;

  const jsonAttachments = message.attachments.filter((attachment) =>
    attachment.name?.toLowerCase().endsWith(".json")
  );

  if (jsonAttachments.size === 0) return;

  for (const attachment of jsonAttachments.values()) {
    try {
      const macroInfo = await downloadAndParseMacro(attachment);

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

      await message.reply({
        embeds: [buildEmbed(attachment.url, macroInfo)],
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

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "upload") return;

  if (!interaction.channel || !isAllowedLocation(interaction.channel)) {
    await interaction.reply({
      content: "This command cannot be used in this channel.",
      ephemeral: true,
    });

    return;
  }

  const attachment = interaction.options.getAttachment("file", true);
  const note = interaction.options.getString("note")?.trim() || null;

  if (!attachment.name?.toLowerCase().endsWith(".json")) {
    await interaction.reply({
      content: "Please upload a file ending in `.json`.",
      ephemeral: true,
    });

    return;
  }

  await interaction.deferReply();

  try {
    const macroInfo = await downloadAndParseMacro(attachment);

    if (!macroInfo) {
      await interaction.editReply({
        content:
          "This is not a valid macro file. The file must contain a non-empty array of actions.",
      });

      return;
    }

    await interaction.editReply({
      embeds: [buildEmbed(attachment.url, macroInfo, note)],
    });

    if (interaction.channel.isThread()) {
      await pinThreadStarter(interaction.channel);
    }
  } catch (error) {
    console.error("Error processing slash-command upload:", error);

    await interaction.editReply({
      content: "Something went wrong while processing the macro.",
    });
  }
});

function isAllowedLocation(channel) {
  const isAllowedChannel = ALLOWED_CHANNEL_IDS.has(channel.id);

  const isThreadInAllowedChannel =
    channel.isThread() &&
    ALLOWED_CHANNEL_IDS.has(channel.parentId);

  return isAllowedChannel || isThreadInAllowedChannel;
}

async function downloadAndParseMacro(attachment) {
  const response = await fetch(attachment.url);

  if (!response.ok) {
    throw new Error(
      `Failed to download attachment: HTTP ${response.status}`
    );
  }

  const jsonText = await response.text();

  return parseMacro(jsonText);
}

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

function buildEmbed(url, macroInfo, note = null) {
  const embed = new EmbedBuilder()
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

  if (note) {
    embed.addFields({
      name: "Note from the user:",
      value: note,
      inline: false,
    });
  }

  return embed;
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
