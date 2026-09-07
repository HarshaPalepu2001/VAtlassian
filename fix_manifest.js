const fs = require('fs');
let lines = fs.readFileSync('manifest.yml', 'utf8').split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('function: totp-resolver') || lines[i].includes('function: admin-resolver')) {
    if (!lines[i-1].includes('resolver:')) {
      const indent = lines[i].match(/^\s*/)[0];
      const newIndent = indent.substring(0, indent.length - 2); // go back two spaces
      lines.splice(i, 0, newIndent + 'resolver:');
      i++; // skip the newly inserted line
    }
  }
}
fs.writeFileSync('manifest.yml', lines.join('\n'));
