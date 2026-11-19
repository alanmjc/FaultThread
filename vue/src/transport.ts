import type { BrowserOptions, ErrorEvent } from '@sentry/vue'
import { sanitizeEvent, type PrivacyPolicy } from './policy.js'

export type TransportFactory = NonNullable<BrowserOptions['transport']>
type ErrorItem = [{ type: 'event' }, ErrorEvent]

// Sentry appends scope attachments after beforeSend. Apply the policy to the final envelope.
export const errorTransport = (makeTransport: TransportFactory, application: string, privacy: PrivacyPolicy): TransportFactory => options => {
  const transport = makeTransport(options)
  return {
    send([header, items]) {
      const events = items.filter((item): item is ErrorItem => item[0].type === 'event').map(([, event]): ErrorItem => {
        const payload = sanitizeEvent(event, application, privacy)
        payload.sdk = { ...header.sdk, settings: { infer_ip: 'never' } }
        return [{ type: 'event' }, payload]
      })
      if (!events.length) return Promise.resolve({})
      // The SDK supplies these headers. A custom transport may receive omitted wire fields.
      const eventId = events[0][1].event_id as string
      const sentAt = header.sent_at as string
      return transport.send([{ event_id: eventId, sent_at: sentAt, sdk: header.sdk }, events])
    },
    flush: timeout => transport.flush(timeout),
  }
}
