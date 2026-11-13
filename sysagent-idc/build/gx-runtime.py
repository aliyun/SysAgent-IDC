import os
import stat
import subprocess
from pathlib import Path

CONFIG = Path('/etc/ld.so.conf.d/sysagent-gx.conf')
CONTENT = b'/usr/lib64\n'
ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}


def trusted(path, directory=False):
    for item in reversed((path, *path.parents)):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Unsafe GX runtime path')
        if item != path and not stat.S_ISDIR(info.st_mode):
            raise RuntimeError('Unsafe GX runtime ancestor')
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            raise RuntimeError('GX runtime directory is missing')
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError('GX runtime file is missing or unsafe')


def install():
    if os.getuid() != 0:
        raise RuntimeError('GX runtime integration requires the package installer')
    result = subprocess.run(
        ['/usr/bin/dpkg-query', '-W', '-f=${Status}\t${Version}', 'gx'],
        env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
    )
    if result.stdout.strip() != b'install ok installed\t0.6.5-2':
        raise RuntimeError('Configured GX 0.6.5-2 is required')
    for filename in ('/usr/bin/gx', '/usr/lib64/libgx.so', '/usr/lib64/libgx_client.so',
                     '/usr/lib64/libgx_nvinfo.bin', '/usr/lib64/libgx_amdinfo.bin', '/etc/libgx.yaml'):
        trusted(Path(filename))
    if not os.access('/usr/bin/gx', os.X_OK):
        raise RuntimeError('GX executable is unavailable')
    trusted(CONFIG.parent, directory=True)
    if CONFIG.exists() or CONFIG.is_symlink():
        trusted(CONFIG)
        if CONFIG.read_bytes() != CONTENT:
            raise RuntimeError('Existing GX loader configuration is not managed by SysAgent')
    else:
        fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(CONTENT)
    subprocess.run(['/sbin/ldconfig'], env=ENV, check=True)
    print('SysAgent: GX 0.6.5-2 runtime and library path are ready.')


if __name__ == '__main__':
    try:
        install()
    except (OSError, RuntimeError, subprocess.SubprocessError):
        raise SystemExit('SysAgent: GX 0.6.5-2 runtime setup failed; do not bypass package dependencies.') from None
