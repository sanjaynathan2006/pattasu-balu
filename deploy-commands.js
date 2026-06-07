const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or playlist')
    .addStringOption(option =>
      option.setName('song').setDescription('Song name or URL').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('playnow')
    .setDescription('Play a song instantly from queue or search')
    .addStringOption(option =>
      option.setName('query').setDescription('Song name, number in queue, or URL').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('autoplay')
    .setDescription('Toggle AutoPlay — bot keeps playing related songs when queue ends'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop music and disconnect'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause music'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume music'),
  new SlashCommandBuilder().setName('loop').setDescription('Cycle loop: OFF → SONG → QUEUE'),
  new SlashCommandBuilder().setName('queue').setDescription('Show current queue')
];

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

rest.put(
  Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
  { body: commands }
)
.then(() => console.log('✅ Commands registered'))
.catch(console.error);
