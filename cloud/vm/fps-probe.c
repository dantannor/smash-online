#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <time.h>
static unsigned long n; static double t0;
static double now(){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec+t.tv_nsec/1e9;}
void SDL_GL_SwapWindow(void *w){
  static void (*real)(void*); if(!real) real=dlsym(RTLD_NEXT,"SDL_GL_SwapWindow");
  real(w); n++; double t=now(); if(t0==0)t0=t;
  if(t-t0>=1.0){ FILE*f=fopen("/tmp/fps.log","a"); if(f){fprintf(f,"%.2f %.1f\n",t,n/(t-t0));fclose(f);} n=0;t0=t; }
}
