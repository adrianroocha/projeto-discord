module.exports = {
  name: 'ready',
  once: true,
  execute(client) {
    console.log(`Bot pronto: ${client.user.tag}`);
  },
};
