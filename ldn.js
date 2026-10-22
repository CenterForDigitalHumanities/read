/*
 * Linked Data Notifications inbox support.
 *
 * The inbox list is user-configurable and persisted; Rerum Inbox is the
 * default. Results are opt-in (persisted checkbox) and previewed before
 * inclusion, similar to the Mirador LDN plugin.
 */

export const DEFAULT_INBOX = 'https://inbox.rerum.io/messages'
const INBOXES_KEY = 'read.ldn.inboxes'
const OPTIN_KEY = 'read.ldn.optin'

export function getInboxes() {
  try {
    const list = JSON.parse(localStorage.getItem(INBOXES_KEY))
    if (Array.isArray(list) && list.length) return list
  } catch {
    /* fall through to default */
  }
  return [DEFAULT_INBOX]
}

// The viewer is served over https, so any other inbox is blocked as mixed
// content or is not a URL at all.
export function isInboxUri(uri) {
  try {
    return new URL(uri).protocol === 'https:'
  } catch {
    return false
  }
}

export function saveInboxes(list) {
  localStorage.setItem(INBOXES_KEY, JSON.stringify(list))
}

export function getOptIn() {
  return localStorage.getItem(OPTIN_KEY) === 'true'
}

export function setOptIn(value) {
  localStorage.setItem(OPTIN_KEY, value ? 'true' : 'false')
}

export function extractMessages(data) {
  if (Array.isArray(data)) return data
  // Rerum Inbox answers with an LDP container: { "@type": "ldp:Container", "contains": [...] }
  for (const key of ['contains', 'ldp:contains', 'messages', 'items']) {
    if (Array.isArray(data?.[key])) return data[key]
  }
  return []
}

export async function queryInbox(inbox, target) {
  const url = new URL(inbox)
  url.searchParams.set('target', target)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Inbox ${inbox} responded ${res.status}`)
  const data = await res.json()
  return extractMessages(data)
}
