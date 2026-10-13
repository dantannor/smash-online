// VM-side latency probe: timestamps (CLOCK_REALTIME, ms) of OSI1 input-file changes and of Xvfb frame changes.
// build: gcc -O2 -o vm-probe vm-probe.c -lX11 -lXext   run: DISPLAY=:99 ./vm-probe /path/input.osi1 [seconds] > log
// Output lines:  F <ms> <port0-3> <buttons>   an OSI1 port record's buttons changed
//                X <ms> <score>               sampled screen differs from the previous grab (mean abs diff, 0..255)
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <sys/shm.h>
#include <sys/ipc.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <fcntl.h>
#include <unistd.h>
#include <time.h>
#define GW 64
#define GH 48
static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_REALTIME, &t); return t.tv_sec * 1000.0 + t.tv_nsec / 1e6; }
int main(int argc, char **argv) {
  const char *osi = argc > 1 ? argv[1] : "/home/smash/.smash-online/input.osi1";
  double secs = argc > 2 ? atof(argv[2]) : 60;
  Display *d = XOpenDisplay(NULL); if (!d) { fprintf(stderr, "no display\n"); return 1; }
  Window root = DefaultRootWindow(d);
  XWindowAttributes wa; XGetWindowAttributes(d, root, &wa);
  XShmSegmentInfo si; XImage *im = XShmCreateImage(d, wa.visual, wa.depth, ZPixmap, NULL, &si, wa.width, wa.height);
  si.shmid = shmget(IPC_PRIVATE, im->bytes_per_line * im->height, IPC_CREAT | 0600); si.shmaddr = im->data = shmat(si.shmid, 0, 0); si.readOnly = False;
  XShmAttach(d, &si); XSync(d, False); shmctl(si.shmid, IPC_RMID, 0);
  int fd = open(osi, O_RDONLY); if (fd < 0) { perror("osi"); return 1; }
  uint8_t prevS[GW * GH * 3] = {0}, curS[GW * GH * 3]; int havePrev = 0;
  uint16_t pb[4] = {0, 0, 0, 0};
  double t0 = now_ms();
  while (now_ms() - t0 < secs * 1000) {
    uint8_t rec[80]; if (pread(fd, rec, 80, 0) == 80) {
      for (int p = 0; p < 4; p++) { uint16_t b = rec[8 + 16 * p + 2] | (rec[8 + 16 * p + 3] << 8); if (b != pb[p]) { printf("F %.3f %d %u\n", now_ms(), p, b); pb[p] = b; } }
    }
    XShmGetImage(d, root, im, 0, 0, AllPlanes);
    int bpp = im->bits_per_pixel / 8;
    for (int y = 0; y < GH; y++) for (int x = 0; x < GW; x++) {
      uint8_t *px = (uint8_t *)im->data + ((y * wa.height / GH) * im->bytes_per_line) + (x * wa.width / GW) * bpp;
      uint8_t *o = curS + (y * GW + x) * 3; o[0] = px[0]; o[1] = px[1]; o[2] = px[2];
    }
    double tg = now_ms();
    if (havePrev) { long s = 0; for (int i = 0; i < GW * GH * 3; i++) s += abs((int)curS[i] - (int)prevS[i]); double sc = s / (double)(GW * GH * 3); if (sc > 0.3) printf("X %.3f %.2f\n", tg, sc); }
    for (int i = 0; i < GW * GH * 3; i++) prevS[i] = curS[i]; havePrev = 1;
    fflush(stdout);
    usleep(500);
  }
  return 0;
}
