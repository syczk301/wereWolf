import { envConfig } from '../../shared/env.js'
import { Resend } from 'resend'

type SendMailInput = {
  to: string
  subject: string
  text: string
  html: string
}

let resendClient: Resend | null = null

function getResendClient() {
  if (!envConfig.emailApiKey) {
    throw new Error('EMAIL_DELIVERY_NOT_CONFIGURED')
  }
  if (!resendClient) {
    resendClient = new Resend(envConfig.emailApiKey)
  }
  return resendClient
}

async function sendByResend(input: SendMailInput) {
  if (!envConfig.emailFrom) {
    throw new Error('EMAIL_DELIVERY_NOT_CONFIGURED')
  }

  try {
    const resend = getResendClient()
    const { error } = await resend.emails.send({
      from: envConfig.emailFrom,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
    })

    if (!error) return

    console.error('[email] resend send failed', {
      name: error.name,
      message: error.message,
    })
    throw new Error('EMAIL_SEND_FAILED')
  } catch (e: any) {
    if (String(e?.message ?? '') === 'EMAIL_DELIVERY_NOT_CONFIGURED') {
      throw e
    }

    console.error('[email] resend send failed', {
      name: e?.name,
      message: e?.message,
      statusCode: e?.statusCode ?? e?.status,
    })
    throw new Error('EMAIL_SEND_FAILED')
  }
}

export async function sendMail(input: SendMailInput) {
  if (envConfig.emailProvider === 'resend') {
    await sendByResend(input)
    return
  }

  console.info(
    `[email:mock] to=${input.to} subject="${input.subject}" text="${input.text.replace(/\s+/g, ' ').trim()}"`,
  )
}
