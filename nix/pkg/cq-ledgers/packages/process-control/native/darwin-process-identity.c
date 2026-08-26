#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>

static int printIdentity(long candidate) {
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

static int printProcessGroup(long candidate) {
  struct proc_bsdinfo info;
  int bytes = proc_pidinfo((int)candidate, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (bytes == 0) return 3;
  if (bytes != sizeof(info)) {
    fputs("short proc_pidinfo result\n", stderr);
    return 4;
  }

  printf("%" PRIu32 "\n", info.pbi_pgid);
  return 0;
}

static int listGroups(void) {
  int listedBytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  if (listedBytes <= 0) {
    fputs("proc_listpids failed\n", stderr);
    return 4;
  }

  pid_t *pids = malloc((size_t)listedBytes);
  if (pids == NULL) {
    fputs("out of memory\n", stderr);
    return 4;
  }

  int bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, listedBytes);
  if (bytes <= 0) {
    free(pids);
    fputs("proc_listpids failed\n", stderr);
    return 4;
  }

  int count = bytes / (int)sizeof(pid_t);
  for (int i = 0; i < count; i++) {
    if (pids[i] <= 1) continue;
    struct proc_bsdinfo info;
    int infoBytes = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (infoBytes != (int)sizeof(info)) continue;
    printf("%" PRIu32 " %" PRIu32 "\n", info.pbi_pid, info.pbi_pgid);
  }

  free(pids);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--list-groups") == 0) {
    return listGroups();
  }

  int processGroupMode = argc == 3 && strcmp(argv[1], "--process-group") == 0;
  if (argc != 2 && !processGroupMode) {
    fputs("usage: cq-process-identity <pid> | --process-group <pid> | --list-groups\n", stderr);
    return 2;
  }

  const char *candidateArgument = processGroupMode ? argv[2] : argv[1];
  char *end = NULL;
  errno = 0;
  long candidate = strtol(candidateArgument, &end, 10);
  if (errno != 0 || end == candidateArgument || *end != '\0' || candidate <= 1) {
    fputs("invalid pid\n", stderr);
    return 2;
  }

  return processGroupMode ? printProcessGroup(candidate) : printIdentity(candidate);
}
