"""Send one command as VS Code does: CR-separated input, without bracketed paste.

Only a disposable test shell is touched. Stdout is JSON; no user startup files
or environment values are loaded.

The master side is non-blocking and the bytes the terminal actually accepted
are counted, because that is the measurement this fixture exists for: an
interactive shell on a pty stops accepting a single logical command line after
a bounded number of bytes, and the rest is simply never delivered. A blocking
write would hang there instead of reporting it.
"""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import sys
import time

request = json.load(open(sys.argv[1], encoding="utf-8"))
pid, master = pty.fork()
if pid == 0:
    os.chdir(request["cwd"])
    os.execve(request["shell"], [request["shell"], "-f"], {
        "PATH": os.defpath,
        "HOME": request["cwd"],
        "TERM": "xterm-256color",
        "LANG": "en_US.UTF-8",
        "PS1": "SPARRING_PRIMARY> ",
        "PS2": "SPARRING_SECONDARY %_> ",
    })


def read_until_primary(timeout):
    deadline = time.monotonic() + timeout
    output = bytearray()
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                break
            if b"SPARRING_PRIMARY> " in output:
                break
    return output.decode("utf-8", errors="replace")


try:
    ready = read_until_primary(5)
    if "SPARRING_PRIMARY> " not in ready:
        raise RuntimeError("test zsh did not reach its initial prompt")
    wire = (request["line"].replace("\r\n", "\n").replace("\n", "\r") + "\r").encode("utf-8")
    fcntl.fcntl(master, fcntl.F_SETFL, os.O_NONBLOCK)
    written = 0
    stalled_at = time.monotonic() + 3
    while written < len(wire) and time.monotonic() < stalled_at:
        try:
            sent = os.write(master, wire[written:])
        except OSError as error:
            if error.errno != errno.EAGAIN:
                raise
            time.sleep(0.05)
            continue
        if sent:
            written += sent
            stalled_at = time.monotonic() + 3
    output = read_until_primary(5)
    print(json.dumps({
        "output": output,
        "returnedToPrompt": "SPARRING_PRIMARY> " in output,
        "sent": len(wire),
        "accepted": written,
    }))
finally:
    # This is only the exact PID created by this test, never a name/group match.
    os.kill(pid, signal.SIGKILL)
    os.close(master)
    os.waitpid(pid, 0)
