import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { i18n } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '@/stores/library'
import {
  NavidromeLoginRequired,
  getNavidromePlaylist,
  listNavidromeUsers,
  setNavidromePlaylistOwner,
} from '@/services/navidrome/client'
import CreatePlaylistDialog from '../CreatePlaylistDialog.vue'
import PlaylistEditDialog from '../PlaylistEditDialog.vue'
import { makeSong } from '@/stores/__tests__/fixtures'
import type { Playlist } from '@/types/library'

vi.mock('@/services/navidrome/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/navidrome/client')>()),
  getNavidromePlaylist: vi.fn(),
  listNavidromeUsers: vi.fn(),
  setNavidromePlaylistOwner: vi.fn(),
}))

const vuetify = createVuetify({ components, directives })
const emitter = { emit: vi.fn() }
const ask = vi.fn()
const global = {
  plugins: [vuetify, i18n],
  mocks: { $emitter: emitter },
  stubs: {
    // In place, so the form is in the wrapper rather than teleported away.
    VDialog: { template: '<div><slot /></div>' },
    NavidromePasswordDialog: { template: '<div />', methods: { ask } },
    CoverArt: true,
  },
}

const playlist = (overrides: Partial<Playlist> = {}) =>
  ({ id: 'p1', name: 'Mix', public: false, comment: 'Old', songs: [], ...overrides }) as Playlist

function signIn(server: 'navidrome-admin' | 'navidrome' | 'jellyfin') {
  const auth = useAuthStore()
  auth.serverType = server === 'jellyfin' ? 'jellyfin' : 'subsonic'
  auth.isAdmin = server === 'navidrome-admin'
  auth.health = {
    ffmpeg: true,
    navidrome_configured: true,
    server_lock: null,
    session_server_type: server === 'jellyfin' ? 'jellyfin' : 'subsonic',
    session_server_software: server === 'jellyfin' ? null : 'navidrome',
  }
}

type EditVm = {
  open: (playlist: Playlist) => void
  save: () => Promise<void>
  name: string
  comment: string
  isPublic: boolean
  ownerId: string
  owners: { value: string }[]
  ownerLoginNeeded: boolean
  signInForOwner: () => Promise<void>
}

async function openEdit(opened = playlist()) {
  const wrapper = mount(PlaylistEditDialog, { global })
  const vm = wrapper.vm as unknown as EditVm
  vm.open(opened)
  await flushPromises()
  return { wrapper, vm }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(listNavidromeUsers).mockResolvedValue([
    { id: 'u1', userName: 'me', name: 'Me' },
    { id: 'u2', userName: 'anna', name: 'Anna' },
  ])
  vi.mocked(getNavidromePlaylist).mockResolvedValue({ ownerId: 'u1' } as never)
  vi.mocked(setNavidromePlaylistOwner).mockResolvedValue()
})

describe('PlaylistEditDialog', () => {
  const stubStore = () => {
    const library = useLibraryStore()
    const update = vi.spyOn(library, 'updatePlaylist').mockResolvedValue()
    const refresh = vi.spyOn(library, 'refreshPlaylistCache').mockResolvedValue()
    return { update, refresh }
  }

  it('sends only what was changed', async () => {
    signIn('navidrome')
    const { update } = stubStore()
    const { vm, wrapper } = await openEdit()

    vm.comment = 'New'
    await vm.save()

    expect(update).toHaveBeenCalledWith('p1', { comment: 'New' })
    expect(wrapper.emitted('saved')![0]![0]).toMatchObject({ comment: 'New', ownerChanged: false })
  })

  it('saves a new name on Enter in the name', async () => {
    signIn('navidrome')
    const { update } = stubStore()
    const { wrapper } = await openEdit()
    const field = wrapper.findComponent({ name: 'PlaylistDialogHead' }).get('input')

    await field.setValue('Renamed')
    await field.trigger('keyup.enter')

    expect(update).toHaveBeenCalledWith('p1', { name: 'Renamed' })
  })

  it("stands the playlist's own albums beside the name", async () => {
    signIn('navidrome')
    const { wrapper } = await openEdit(playlist({ songs: [makeSong('a', { coverArtId: 'al-1' })] }))

    expect(wrapper.findComponent({ name: 'PlaylistDialogHead' }).props('covers')).toEqual(['al-1'])
  })

  it('makes no call when nothing was changed', async () => {
    signIn('navidrome')
    const { update } = stubStore()
    const { vm, wrapper } = await openEdit()

    await vm.save()

    expect(update).not.toHaveBeenCalled()
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('can clear a description', async () => {
    signIn('navidrome')
    const { update } = stubStore()
    const { vm } = await openEdit()

    vm.comment = ''
    await vm.save()

    expect(update).toHaveBeenCalledWith('p1', { comment: '' })
  })

  it('has no description or public switch where the server ignores them', async () => {
    signIn('jellyfin')
    const { update } = stubStore()
    const { vm, wrapper } = await openEdit(playlist({ comment: undefined }))

    expect(wrapper.findComponent({ name: 'PlaylistVisibility' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'VTextarea' }).exists()).toBe(false)
    vm.isPublic = true
    vm.comment = 'x'
    vm.name = 'Renamed'
    await vm.save()
    expect(update).toHaveBeenCalledWith('p1', { name: 'Renamed' })
  })

  it('offers the owner to a Navidrome admin only', async () => {
    signIn('navidrome')
    expect((await openEdit()).vm.owners).toEqual([])
    expect(listNavidromeUsers).not.toHaveBeenCalled()

    signIn('navidrome-admin')
    const { vm } = await openEdit()
    expect(vm.owners.map((owner) => owner.value)).toEqual(['u1', 'u2'])
    expect(vm.ownerId).toBe('u1')
  })

  it('changes the owner only when another was picked', async () => {
    signIn('navidrome-admin')
    const { refresh } = stubStore()
    const unchanged = await openEdit()
    await unchanged.vm.save()
    expect(setNavidromePlaylistOwner).not.toHaveBeenCalled()

    const { vm, wrapper } = await openEdit()
    vm.ownerId = 'u2'
    await vm.save()

    expect(setNavidromePlaylistOwner).toHaveBeenCalledWith('p1', 'u2')
    expect(refresh).toHaveBeenCalled()
    expect(wrapper.emitted('saved')![0]![0]).toMatchObject({ ownerChanged: true })
  })

  it('offers a sign-in when Navidrome wants the password, then loads the owners', async () => {
    signIn('navidrome-admin')
    vi.mocked(listNavidromeUsers).mockRejectedValueOnce(new NavidromeLoginRequired())
    const { vm } = await openEdit()
    expect(vm.ownerLoginNeeded).toBe(true)

    ask.mockResolvedValue(true)
    await vm.signInForOwner()

    expect(vm.ownerLoginNeeded).toBe(false)
    expect(vm.owners).toHaveLength(2)
  })

  it('still edits the rest when the owners cannot be loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    signIn('navidrome-admin')
    const { update } = stubStore()
    vi.mocked(listNavidromeUsers).mockRejectedValueOnce(new Error('500'))
    const { vm } = await openEdit()

    vm.name = 'Renamed'
    await vm.save()

    expect(vm.owners).toEqual([])
    expect(update).toHaveBeenCalledWith('p1', { name: 'Renamed' })
    expect(setNavidromePlaylistOwner).not.toHaveBeenCalled()
  })

  it('asks for the password mid-save and does not repeat what already went through', async () => {
    signIn('navidrome-admin')
    const { update } = stubStore()
    const { vm, wrapper } = await openEdit()
    vi.mocked(setNavidromePlaylistOwner).mockRejectedValueOnce(new NavidromeLoginRequired())
    ask.mockResolvedValue(true)

    vm.name = 'Renamed'
    vm.ownerId = 'u2'
    await vm.save()
    await flushPromises()

    expect(update).toHaveBeenCalledTimes(1)
    expect(setNavidromePlaylistOwner).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('stays open and says so when saving fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    signIn('navidrome')
    const { update } = stubStore()
    update.mockRejectedValue(new Error('refused'))
    const { vm, wrapper } = await openEdit()

    vm.name = 'Renamed'
    await vm.save()

    expect(emitter.emit).toHaveBeenCalledWith(
      'toast',
      expect.objectContaining({ level: 'error', message: 'refused' }),
    )
    expect(wrapper.emitted('saved')).toBeUndefined()
  })
})

describe('CreatePlaylistDialog', () => {
  type CreateVm = {
    open: (ids: string[]) => void
    confirm: () => Promise<void>
    name: string
    comment: string
    isPublic: boolean
  }

  async function openCreate() {
    const wrapper = mount(CreatePlaylistDialog, { global })
    const vm = wrapper.vm as unknown as CreateVm
    vm.open(['s1'])
    await flushPromises()
    return { wrapper, vm }
  }

  it('hands the description and public flag over', async () => {
    signIn('navidrome')
    const create = vi.spyOn(useLibraryStore(), 'createPlaylist').mockResolvedValue()
    const { vm } = await openCreate()

    vm.name = 'Mix'
    vm.comment = '  Long drives  '
    vm.isPublic = true
    await vm.confirm()

    expect(create).toHaveBeenCalledWith('Mix', ['s1'], { comment: 'Long drives', public: true })
  })

  it('asks nothing extra of a plain playlist', async () => {
    signIn('navidrome')
    const create = vi.spyOn(useLibraryStore(), 'createPlaylist').mockResolvedValue()
    const { vm } = await openCreate()

    vm.name = 'Mix'
    await vm.confirm()

    expect(create).toHaveBeenCalledWith('Mix', ['s1'], {})
  })

  it('has no such fields where the server ignores them', async () => {
    signIn('jellyfin')
    const { wrapper } = await openCreate()

    expect(wrapper.findComponent({ name: 'PlaylistVisibility' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'VTextarea' }).exists()).toBe(false)
  })

  it('creates on Enter in the name, and not without a name', async () => {
    signIn('jellyfin')
    const create = vi.spyOn(useLibraryStore(), 'createPlaylist').mockResolvedValue()
    const { wrapper } = await openCreate()
    const field = wrapper.get('input.playlist-dialog-head__name')

    await field.setValue('   ')
    await field.trigger('keyup.enter')
    expect(create).not.toHaveBeenCalled()

    await field.setValue('Mix')
    await field.trigger('keyup.enter')
    expect(create).toHaveBeenCalledWith('Mix', ['s1'], {})
  })

  it('picks private or public from its two tiles', async () => {
    signIn('navidrome')
    const { wrapper, vm } = await openCreate()
    const tiles = wrapper.findComponent({ name: 'PlaylistVisibility' }).findAll('button')

    await tiles[1]!.trigger('click')
    expect(vm.isPublic).toBe(true)

    await tiles[0]!.trigger('click')
    expect(vm.isPublic).toBe(false)
  })

  it('forgets what was typed the last time', async () => {
    signIn('navidrome')
    const { vm } = await openCreate()
    vm.comment = 'x'
    vm.isPublic = true

    vm.open([])

    expect(vm.comment).toBe('')
    expect(vm.isPublic).toBe(false)
  })
})
