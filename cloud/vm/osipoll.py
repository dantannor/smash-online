import os, sys, time, json, struct
path, dur, port = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
fd = os.open(path, os.O_RDONLY)
t0 = time.perf_counter(); last = None; lastseq = None
changes = []; seqt = []
while time.perf_counter() - t0 < dur:
    d = os.pread(fd, 80, 0)
    if len(d) == 80:
        o = 8 + 16 * (port - 1)
        tup = (d[o], d[o+1], *struct.unpack_from("<Hhh", d, o+2))
        t = (time.perf_counter() - t0) * 1000
        if tup != last: changes.append((round(t, 1), *tup)); last = tup
        if d[5] != lastseq: seqt.append(round(t, 1)); lastseq = d[5]
    time.sleep(0.0004)
print(json.dumps({"changes": changes, "seqt": seqt, "mute": d[4]}))
