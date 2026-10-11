import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ConnectApiError, fetchConnect } from '@/services/connect/http'
import { useAuthStore } from '@/stores/auth'
import {
  NavidromeLoginRequired,
  NavidromePasswordRejected,
  createSmartPlaylist,
  getNavidromePlaylist,
  loginToNavidrome,
  updateSmartPlaylist,
} from '../client'

vi.mock('@/services/connect/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/connect/http')>()),
  fetchConnect: vi.fn(),
}))

const fetchMock = vi.mocked(fetchConnect)

function refused(detail: string): ConnectApiError {
  return new ConnectApiError(`Connect request failed: ${detail}`, { detail })
}

const loginRequired = () => refused('navidrome_login_required')
const passwordRejected = () => refused('navidrome_password_rejected')

/** Answers each call in turn: a value, or an error to throw. */
function answer(...answers: unknown[]) {
  for (const next of answers) {
    if (next instanceof Error) fetchMock.mockRejectedValueOnce(next)
    else fetchMock.mockResolvedValueOnce(next)
  }
}

function paths(): string[] {
  return fetchMock.mock.calls.map(([path]) => path)
}

describe('the Navidrome client', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    fetchMock.mockReset()
    useAuthStore().password = 'stored-secret'
  })

  it('asks no password while connect still holds a token', async () => {
    answer({ id: 'pl1', rules: null })

    await getNavidromePlaylist('pl1')

    expect(paths()).toEqual(['/navidrome/api/playlist/pl1'])
  })

  it('logs in with the stored password once, then asks again', async () => {
    answer(loginRequired(), { status: 'ok' }, { id: 'pl1', name: 'Mix' })

    const playlist = await getNavidromePlaylist('pl1')

    expect(playlist.name).toBe('Mix')
    expect(paths()).toEqual([
      '/navidrome/api/playlist/pl1',
      '/navidrome/session',
      '/navidrome/api/playlist/pl1',
    ])
    expect(fetchMock.mock.calls[1]![1]).toEqual({
      method: 'POST',
      body: { password: 'stored-secret' },
    })
  })

  it('leaves the password to the user when none is stored', async () => {
    useAuthStore().password = ''
    answer(loginRequired())

    await expect(getNavidromePlaylist('pl1')).rejects.toBeInstanceOf(NavidromeLoginRequired)
    expect(paths()).toEqual(['/navidrome/api/playlist/pl1'])
  })

  it('leaves it to the user when the stored one no longer works', async () => {
    answer(loginRequired(), passwordRejected())

    await expect(getNavidromePlaylist('pl1')).rejects.toBeInstanceOf(NavidromeLoginRequired)
  })

  it('does not go round in circles when a fresh login is refused at once', async () => {
    answer(loginRequired(), { status: 'ok' }, loginRequired())

    await expect(getNavidromePlaylist('pl1')).rejects.toBeInstanceOf(NavidromeLoginRequired)
    expect(paths().filter((path) => path === '/navidrome/session')).toHaveLength(1)
  })

  it('passes any other failure on as it came', async () => {
    const failure = refused('Navidrome: Updating playlist: Permission denied')
    answer(failure)

    await expect(updateSmartPlaylist('pl1', { name: 'x' })).rejects.toBe(failure)
    expect(paths()).toEqual(['/navidrome/api/playlist/pl1'])
  })

  it('says so when the password typed in is wrong', async () => {
    answer(passwordRejected())

    await expect(loginToNavidrome('wrong')).rejects.toBeInstanceOf(NavidromePasswordRejected)
  })

  it('creates a smart playlist and answers its id', async () => {
    answer({ id: 'new-id' })
    const rules = { all: [{ is: { loved: true } }] }

    const id = await createSmartPlaylist({ name: 'Loved', rules })

    expect(id).toBe('new-id')
    expect(fetchMock).toHaveBeenCalledWith('/navidrome/api/playlist', {
      method: 'POST',
      body: { name: 'Loved', rules },
    })
  })

  it('sends only the changes on an update', async () => {
    answer({})
    const rules = { any: [{ contains: { genre: 'jazz' } }] }

    await updateSmartPlaylist('pl/1', { rules })

    expect(fetchMock).toHaveBeenCalledWith('/navidrome/api/playlist/pl%2F1', {
      method: 'PUT',
      body: { rules },
    })
  })
})
