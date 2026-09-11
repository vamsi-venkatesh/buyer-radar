// A minimal SMTP submission client built on node:tls. No dependencies.
//
// It speaks exactly enough SMTP to hand one message to a submission server over
// implicit TLS (smtps://user:pass@host:465): greeting, EHLO, AUTH LOGIN, MAIL
// FROM, RCPT TO, DATA, QUIT. It does not do STARTTLS, pipelining, DSN or
// anything else, and it never retries - a failed send is reported as a failed
// send.

import tls from 'node:tls';

export class SmtpError extends Error {
  constructor(message, { stage, code, reply } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.stage = stage || null;
    this.code = code || null;
    this.reply = reply || null;
  }
}

/**
 * smtps://user:pass@host:465 -> its parts. The password is returned so it can
 * be sent; it is never put into a transcript, a receipt or a log line.
 */
export function parseSmtpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new SmtpError(`RADAR_SMTP_URL is not a URL: ${String(raw).replace(/:[^:@/]*@/, ':***@')}`);
  }
  if (u.protocol !== 'smtps:') {
    throw new SmtpError(`RADAR_SMTP_URL must start with smtps:// (got ${u.protocol}//)`);
  }
  if (!u.hostname) throw new SmtpError('RADAR_SMTP_URL has no host');
  return {
    host: u.hostname,
    port: Number(u.port || 465),
    user: u.username ? decodeURIComponent(u.username) : null,
    pass: u.password ? decodeURIComponent(u.password) : null,
  };
}

/** CRLF line endings and SMTP dot-stuffing, as RFC 5321 section 4.5.2 requires. */
export function prepareData(message) {
  const crlf = String(message).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  return crlf.replace(/^\./gm, '..');
}

/** A reply is finished when a line starts with three digits and a space. */
function replyComplete(buffer) {
  const lines = buffer.split('\r\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\d{3} /.test(lines[i])) return true;
  }
  return false;
}

function makeConversation(socket, { timeoutMs }) {
  let buffer = '';
  let waiting = null;
  let closed = null;

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (waiting && replyComplete(buffer)) {
      const reply = buffer;
      buffer = '';
      const w = waiting;
      waiting = null;
      clearTimeout(w.timer);
      w.resolve(reply.trim());
    }
  });
  const fail = (err) => {
    closed = err;
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(err);
      waiting = null;
    }
  };
  socket.on('error', (err) => fail(new SmtpError(`socket error: ${err.message}`)));
  socket.on('close', () => fail(new SmtpError('server closed the connection')));

  return {
    read(stage) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(closed);
        if (replyComplete(buffer)) {
          const reply = buffer;
          buffer = '';
          return resolve(reply.trim());
        }
        const timer = setTimeout(
          () => reject(new SmtpError(`timed out waiting for the server at ${stage}`, { stage })),
          timeoutMs
        );
        waiting = { resolve, reject, timer };
        return undefined;
      });
    },
    write(line) {
      socket.write(line);
    },
  };
}

const code = (reply) => Number(String(reply).slice(0, 3));

/**
 * Send one message. `connect` defaults to implicit TLS; the test suite passes a
 * plain node:net connector so the protocol can be exercised against a local
 * fake server without a certificate. Returns a transcript of stages and reply
 * codes - never the credentials.
 */
export async function sendMail({
  url,
  from,
  to,
  message,
  timeoutMs = 30000,
  connect,
  ehloName = 'buyer-radar',
}) {
  const { host, port, user, pass } = parseSmtpUrl(url);
  const recipients = Array.isArray(to) ? to : [to];
  if (!from) throw new SmtpError('sendMail needs a from address');
  if (!recipients.length) throw new SmtpError('sendMail needs at least one recipient');

  const socket = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SmtpError(`timed out connecting to ${host}:${port}`, { stage: 'connect' })),
      timeoutMs
    );
    const s = connect
      ? connect({ host, port }, () => {
          clearTimeout(timer);
          resolve(s);
        })
      : tls.connect({ host, port, servername: host }, () => {
          clearTimeout(timer);
          resolve(s);
        });
    s.once('error', (err) => {
      clearTimeout(timer);
      reject(new SmtpError(`cannot connect to ${host}:${port}: ${err.message}`, { stage: 'connect' }));
    });
  });

  const conv = makeConversation(socket, { timeoutMs });
  const transcript = [];

  const step = async (stage, line, expected) => {
    if (line !== null) conv.write(`${line}\r\n`);
    const reply = await conv.read(stage);
    const c = code(reply);
    transcript.push({ stage, code: c });
    if (!expected.includes(c)) {
      throw new SmtpError(`${stage} failed: ${reply.split('\r\n')[0]}`, { stage, code: c, reply });
    }
    return reply;
  };

  try {
    await step('greeting', null, [220]);
    await step('ehlo', `EHLO ${ehloName}`, [250]);
    if (user && pass) {
      await step('auth', 'AUTH LOGIN', [334]);
      await step('auth-user', Buffer.from(user, 'utf8').toString('base64'), [334]);
      await step('auth-pass', Buffer.from(pass, 'utf8').toString('base64'), [235]);
    }
    await step('mail-from', `MAIL FROM:<${from}>`, [250]);
    for (const rcpt of recipients) await step('rcpt-to', `RCPT TO:<${rcpt}>`, [250, 251]);
    await step('data', 'DATA', [354]);
    conv.write(`${prepareData(message)}\r\n.\r\n`);
    const accepted = await conv.read('data-body');
    const acceptedCode = code(accepted);
    transcript.push({ stage: 'data-body', code: acceptedCode });
    if (acceptedCode !== 250) {
      throw new SmtpError(`server refused the message: ${accepted.split('\r\n')[0]}`, {
        stage: 'data-body',
        code: acceptedCode,
        reply: accepted,
      });
    }
    try {
      await step('quit', 'QUIT', [221]);
    } catch {
      // A server that drops the socket after DATA has still accepted the message.
    }
    return { accepted: true, host, port, recipients, transcript, reply: accepted.split('\r\n')[0] };
  } finally {
    socket.end();
    socket.destroy();
  }
}
