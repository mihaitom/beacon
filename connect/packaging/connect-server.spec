# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the Beacon Connect backend.

Source paths below (main.py, pathex) are relative to this file's own
directory (packaging/), which is how PyInstaller resolves them regardless of
the working directory. Must still be *run* with connect/ as the working
directory though, so `uv run` finds pyproject.toml and dist/build/ land in
connect/dist, connect/build (not packaging/dist, packaging/build) — see
packaging/build-binary.py, which handles this.

Build:
    cd connect
    uv run pyinstaller packaging/connect-server.spec
"""

block_cipher = None

a = Analysis(
    ['../main.py'],
    pathex=['..'],
    binaries=[],
    datas=[],
    hiddenimports=[
        # uvicorn internals that are imported dynamically
        'uvicorn.lifespan.on',
        'uvicorn.lifespan.off',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.protocols.websockets.websockets_impl',
        'uvicorn.logging',
        # fastapi / starlette internals
        'starlette.routing',
        'starlette.middleware.cors',
        # soco / zeroconf for Sonos discovery
        'soco',
        'zeroconf',
        'zeroconf._handlers',
        # pyatv / aiohttp / zeroconf for AirPlay
        'pyatv',
        'pyatv.protocols',
        'pyatv.protocols.raop',
        'aiohttp',
        # dotenv
        'dotenv',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='connect-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='connect-server',
)
