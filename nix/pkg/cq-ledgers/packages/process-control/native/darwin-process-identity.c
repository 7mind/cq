#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc_info.h>

int main(int argc, char **argv) {
  if (argc != 2) {
    fputs("usage: cq-process-identity <pid>\n", stderr);
    return 2;
  }

  char *end = NULL;
  errno = 0;
  long candidate = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\0' || candidate <= 1) {
    fputs("invalid pid\n", stderr);
    return 2;
  }

  struct proc_bsdinfo info;
  int bytes = proc_pidinfo((int)candidate, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (bytes == 0) return 3;
  if (bytes != sizeof(info)) {
    fputs("short proc_pidinfo result\n", stderr);
    return 4;
  }

  printf("%" PRIu64 ".%" PRIu64 "\n", info.pbi_start_tvsec, info.pbi_start_tvusec);
  return 0;
}
