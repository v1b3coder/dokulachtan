#!/usr/bin/env python3
"""GDB skript: odposlech SM klíčů z běžícího middleware (docs/26 § 14).

Použití (skript se načítá do GDB, ne do Pythonu):

  xvfb-run -a --server-args="-screen 0 1400x1000x24" \
    gdb -batch -x scripts/eop_gdb_extract.py \
    --args .venv/bin/python scripts/eop_card_sign.py --sign

Breakpointy se staví až po načtení `libeop2v1czep11.so`:

  0x1137fc  c_ias_applet::mutual_authenticate (2-arg)
  0x4ae93   AES key schedule (16/24/32B klíč)

Na vstupu `mutual_authenticate` se z `param_1[3]` (crypto objekt) přečte
vtable a nastaví se breakpointy na `+0x48` (init), `+0x50` (feed),
`+0x58` (derive) a `+0x88`/`+0x90`/`+0x98` (get secret). Skript jen
loguje; do běhu nezasahuje.

QPIN dialog je potřeba obsloužit stejně jako u `eop_card_sign_xvfb.sh`.
"""
import gdb


def _read(addr, n):
    try:
        return gdb.selected_inferior().read_memory(addr, n).tobytes()
    except Exception:
        return None


def _u64(addr):
    b = _read(addr, 8)
    return None if b is None else int.from_bytes(b, 'little')


def _looks_ptr(v):
    return v is not None and 0x100000 < v < 0x800000000000


def _lib_base(substr='libeop2v1czep11'):
    """Báze mapování knihovny (offset 0 v /proc/<pid>/maps)."""
    pid = gdb.selected_inferior().pid
    try:
        with open('/proc/%d/maps' % pid) as f:
            for line in f:
                if substr in line:
                    parts = line.split()
                    if int(parts[2], 16) == 0:
                        return int(parts[0].split('-')[0], 16)
    except OSError:
        pass
    return None


class _After(gdb.FinishBreakpoint):
    """Po návratu z funkce vypíše výstupní buffer."""

    def __init__(self, addr, n, label):
        super().__init__(internal=True)
        self.addr = addr
        self.n = n
        self.label = label

    def stop(self):
        b = _read(self.addr, self.n)
        if b is not None:
            print('   AFTER %s [%#x] %s' % (self.label, self.addr, b.hex()))
        return False


class _KeyBP(gdb.Breakpoint):
    def __init__(self, spec, name):
        super().__init__(spec, gdb.BP_BREAKPOINT, internal=False)
        self.bpname = name

    def stop(self):
        rdi = int(gdb.parse_and_eval('$rdi'))
        rsi = int(gdb.parse_and_eval('$rsi'))
        rdx = int(gdb.parse_and_eval('$rdx'))
        print('BP %s rdi=%#x rsi=%#x rdx=%#x' % (self.bpname, rdi, rsi, rdx))
        if _looks_ptr(rsi) and 0 < rdx <= 0x100:
            b = _read(rsi, rdx)
            if b:
                print('   [rsi,%d] %s' % (rdx, b.hex()))
        if self.bpname == 'derive' and _looks_ptr(rsi):
            n = _u64(rdx) or 64
            _After(rsi, min(n, 0x100), self.bpname)
        return False


class _MutBP(gdb.Breakpoint):
    def stop(self):
        rdi = int(gdb.parse_and_eval('$rdi'))
        rsi = int(gdb.parse_and_eval('$rsi'))
        rdx = int(gdb.parse_and_eval('$rdx'))
        print('MUTUAL rdi=%#x rsi=%#x rdx=%#x' % (rdi, rsi, rdx))
        key_obj = _u64(rdi + 24)
        print('   key_obj=%#x' % (key_obj or 0))
        if key_obj:
            vptr = _u64(key_obj)
            print('   key vptr=%#x' % (vptr or 0))
            if vptr:
                for off, nm in ((0x48, 'init'), (0x50, 'feed'), (0x58, 'derive'),
                                (0x88, 'k88'), (0x90, 'k90'), (0x98, 'k98')):
                    fn = _u64(vptr + off)
                    if fn:
                        _KeyBP('*%#x' % fn, nm)
        return False


_armed = False


def _on_new_objfile(ev):
    global _armed
    if _armed:
        return
    fn = ev.new_objfile.filename or ''
    if 'libeop2v1czep11' not in fn:
        return
    base = _lib_base()
    print('OBJFILE %s BASE %#x' % (fn, base or 0))
    if base:
        _MutBP('*%#x' % (base + 0x1137fc))
        _armed = True


gdb.events.new_objfile.connect(_on_new_objfile)

gdb.execute('set pagination off')
gdb.execute('set confirm off')
gdb.execute('set breakpoint pending on')
gdb.execute('run')
