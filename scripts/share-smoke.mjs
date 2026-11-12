// Live integration check against the CLI-linked project. Creates temporary staff
// accounts and small files, then removes them. Requires Supabase CLI access.
import { createClient } from '@supabase/supabase-js'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const ref = readFileSync('supabase/.temp/project-ref', 'utf8').trim()
const keys = JSON.parse(execFileSync('supabase', ['projects', 'api-keys', '--project-ref', ref, '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
const url = `https://${ref}.supabase.co`
const service = keys.find(k => k.name === 'service_role').api_key
const anonKey = keys.find(k => k.name === 'anon').api_key
const options = { auth: { persistSession: false, autoRefreshToken: false } }
const admin = createClient(url, service, options)
let sender, senderSession, other
const users = []
const paths = []
const check = (result) => { if (result.error) throw result.error; return result.data }
try {
  for (let i = 0; i < 2; i++) {
    const username = `share-test-${crypto.randomUUID()}`
    const email = `${username}@workers.jadegroup.app`
    const password = crypto.randomUUID() + 'A1!'
    const { user } = check(await admin.auth.admin.createUser({ email, password, email_confirm: true }))
    users.push(user.id)
    check(await admin.from('profiles').insert({ id: user.id, username, display_name: 'File drop validation', role: 'worker', active: true }))
    const client = createClient(url, anonKey, options)
    const session = check(await client.auth.signInWithPassword({ email, password })).session
    if (i === 0) {
      sender = client
      senderSession = session
    } else other = client
  }
  const receiver = createClient(url, anonKey, options)
  check(await receiver.auth.setSession(senderSession))
  const name = 'File drop résumé #1?.txt'
  const contents = 'Phone → laptop → PC: verified bytes.'
  for (let i = 0; i < 2; i++) {
    const path = `${users[0]}/${crypto.randomUUID()}--${Buffer.from(name).toString('hex')}`
    check(await sender.storage.from('file-drops').upload(path, new Blob([contents], { type: 'text/plain' })))
    paths.push(path)
  }
  const listed = check(await receiver.storage.from('file-drops').list(users[0]))
  assert.equal(listed.length, 2, 'duplicate names retained')
  assert.equal(Buffer.from(listed[0].name.split('--')[1], 'hex').toString('utf8'), name)
  assert.equal(await check(await receiver.storage.from('file-drops').download(paths[0])).text(), contents)
  const strangers = check(await other.storage.from('file-drops').list(users[0]))
  assert.equal(strangers.length, 0)
  assert((await other.storage.from('file-drops').download(paths[0])).error)
  assert((await other.storage.from('file-drops').upload(`${users[0]}/intruder.txt`, new Blob(['blocked']))).error)
  check(await other.storage.from('file-drops').remove([paths[0]]))
  assert.equal(await check(await receiver.storage.from('file-drops').download(paths[0])).text(), contents, 'other account cannot delete')
  const anon = createClient(url, anonKey, options)
  assert((await anon.storage.from('file-drops').download(paths[0])).error)
  check(await admin.from('profiles').update({ active: false }).eq('id', users[0]))
  assert.equal(check(await sender.storage.from('file-drops').list(users[0])).length, 0)
  assert((await sender.storage.from('file-drops').upload(`${users[0]}/disabled.txt`, new Blob(['blocked']))).error)
  check(await admin.from('profiles').update({ active: true }).eq('id', users[0]))
  check(await receiver.storage.from('file-drops').remove([paths[1]]))
  assert.equal(check(await sender.storage.from('file-drops').list(users[0])).length, 1)
  // Text snippets and device rooms use the same ownership boundary as files.
  const text = check(await sender.from('shared_texts').insert({ user_id: users[0], content: 'Private text smoke check' }).select('id').single())
  assert.equal(check(await other.from('shared_texts').select('id').eq('id', text.id)).length, 0)
  assert((await other.from('shared_texts').insert({ user_id: users[0], content: 'blocked' })).error)
  check(await other.from('shared_texts').delete().eq('id', text.id))
  assert.equal(check(await sender.from('shared_texts').select('id').eq('id', text.id)).length, 1)
  assert((await sender.from('shared_texts').insert({ user_id: users[0], content: 'a'.repeat(10001) })).error)
  check(await sender.from('shared_texts').delete().eq('id', text.id))
  const subscribe = channel => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Realtime subscription timed out')), 15000)
    channel.subscribe(status => {
      if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT'].includes(status)) { clearTimeout(timer); resolve(status) }
    })
  })
  await sender.realtime.setAuth(senderSession.access_token)
  await other.realtime.setAuth()
  const own = sender.channel(`share:${users[0]}`, { config: { private: true } })
  assert.equal(await subscribe(own), 'SUBSCRIBED')
  const foreign = other.channel(`share:${users[0]}`, { config: { private: true } })
  assert.notEqual(await subscribe(foreign), 'SUBSCRIBED')
  console.log('PASS: cross-session file transfer, byte integrity, filenames, private file/text ownership, disabled-account denial, text size limit and private device-room authorization.')
} finally {
  await sender?.removeAllChannels()
  await other?.removeAllChannels()
  if (paths.length) check(await admin.storage.from('file-drops').remove(paths))
  for (const id of users) check(await admin.auth.admin.deleteUser(id))
}
