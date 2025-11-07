const readline = require('node:readline');

async function promptYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () =>
    new Promise((resolve) => {
      rl.question(`${question} (y/n): `, (answer) => {
        resolve(answer.trim().toLowerCase());
      });
    });
  try {
    while (true) {
      const reply = await ask();
      if (['y', 'yes'].includes(reply)) return true;
      if (['n', 'no'].includes(reply)) return false;
      console.log("Please answer with 'y' or 'n'.");
    }
  } finally {
    rl.close();
  }
}

module.exports = { promptYesNo };
