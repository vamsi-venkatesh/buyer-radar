// A fake SMTP submission server on node:net, for exercising the client's side
// of the dialogue. It is deliberately local-only and it never relays anything:
// it records what it was told and answers with the codes it was configured to
// answer with. No real SMTP server is ever contacted by the test suite.

import net from 'node:net';

/**
 * Options are the reply lines to override, plus an optional `host`:
 *   startFakeSmtp({ rcptTo: '550 5.1.1 No such user' })
 */
export function startFakeSmtp(options = {}) {
  const { host = '127.0.0.1', ...replies } = options;
  const R = {
    greeting: '220 fake.local ESMTP ready',
    ehlo: '250-fake.local\r\n250-AUTH LOGIN PLAIN\r\n250-SIZE 35882577\r\n250 8BITMIME',
    authChallengeUser: '334 VXNlcm5hbWU6',
    authChallengePass: '334 UGFzc3dvcmQ6',
    auth: '235 2.7.0 Accepted',
    mailFrom: '250 2.1.0 Ok',
    rcptTo: '250 2.1.5 Ok',
    data: '354 End data with <CR><LF>.<CR><LF>',
    dataAccepted: '250 2.0.0 Ok: queued as FAKE123',
    quit: '221 2.0.0 Bye',
    ...replies,
  };

  const sessions = [];
  const server = net.createServer((socket) => {
    const session = { commands: [], authUser: null, authPass: null, message: '', recipients: [] };
    sessions.push(session);
    let inData = false;
    let expecting = null;
    let buffer = '';

    socket.setEncoding('utf8');
    socket.write(`${R.greeting}\r\n`);

    socket.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write(`${R.dataAccepted}\r\n`);
          } else {
            // Undo the client's dot-stuffing so the test sees the real message.
            session.message += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
          continue;
        }

        if (expecting === 'user') {
          session.authUser = Buffer.from(line, 'base64').toString('utf8');
          expecting = 'pass';
          socket.write(`${R.authChallengePass}\r\n`);
          continue;
        }
        if (expecting === 'pass') {
          session.authPass = Buffer.from(line, 'base64').toString('utf8');
          expecting = null;
          socket.write(`${R.auth}\r\n`);
          continue;
        }

        session.commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) socket.write(`${R.ehlo}\r\n`);
        else if (upper === 'AUTH LOGIN') {
          expecting = 'user';
          socket.write(`${R.authChallengeUser}\r\n`);
        } else if (upper.startsWith('MAIL FROM')) socket.write(`${R.mailFrom}\r\n`);
        else if (upper.startsWith('RCPT TO')) {
          session.recipients.push(line.slice(line.indexOf(':') + 1).trim());
          socket.write(`${R.rcptTo}\r\n`);
        } else if (upper === 'DATA') {
          inData = true;
          socket.write(`${R.data}\r\n`);
        } else if (upper === 'QUIT') {
          socket.write(`${R.quit}\r\n`);
          socket.end();
        } else socket.write('502 5.5.2 Not implemented\r\n');
      }
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const { port } = server.address();
      resolve({
        host,
        port,
        sessions,
        url: (user = 'owner@example.test', pass = 'secret') =>
          `smtps://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
