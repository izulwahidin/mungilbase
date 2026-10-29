import nodemailer from 'nodemailer'
import type { EmailConfig } from '../config/schema.js'

export interface EmailMessage {
  to: string
  subject: string
  text: string
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>
}

/**
 * `log` is a development provider. In production it would print reset links
 * and verification tokens into the log stream, so it is refused outright.
 */
export function createMailer(config: EmailConfig, env: NodeJS.ProcessEnv = process.env): Mailer {
  if (config.provider === 'log') {
    if (env.NODE_ENV === 'production') {
      throw new Error('email.provider "log" is not allowed in production')
    }
    return {
      async send(message) {
        console.log(
          JSON.stringify({
            level: 'info',
            event: 'email_logged',
            to: message.to,
            subject: message.subject,
            text: message.text,
          }),
        )
      },
    }
  }

  const smtp = config.smtp
  if (!smtp) throw new Error('email.smtp is required for the smtp provider')

  const password = smtp.user ? env[smtp.passwordEnv] : undefined
  if (smtp.user && !password) {
    throw new Error(`Missing SMTP password in ${smtp.passwordEnv}`)
  }

  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: password } : undefined,
  })

  return {
    async send(message) {
      await transport.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      })
    },
  }
}
