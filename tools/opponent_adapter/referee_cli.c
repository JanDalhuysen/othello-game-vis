#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <io.h>
#define dup _dup
#define dup2 _dup2
#define close _close
#else
#include <unistd.h>
#endif

#include "comms.h"

int initialise_comms(unsigned long int ip, int port);
int receive_message(int *pile);
int send_move(char *move);
void close_comms(void);

static void rstrip(char *value)
{
    size_t len = strlen(value);
    while (len > 0 && (value[len - 1] == '\n' || value[len - 1] == '\r'))
    {
        value[len - 1] = '\0';
        len--;
    }
}

static int call_initialise(void)
{
    const char *null_device = "NUL";
#ifndef _WIN32
    null_device = "/dev/null";
#endif

    int saved_fd = dup(fileno(stdout));
    if (saved_fd < 0)
    {
        return 0;
    }

    FILE *null_file = fopen(null_device, "w");
    if (!null_file)
    {
        close(saved_fd);
        return 0;
    }

    fflush(stdout);
    dup2(fileno(null_file), fileno(stdout));
    int ok = initialise_comms(0, 0);
    fflush(stdout);
    dup2(saved_fd, fileno(stdout));
    close(saved_fd);
    fclose(null_file);
    return ok;
}

int main(void)
{
    char line[256];
    int initialised = 0;

    while (fgets(line, sizeof(line), stdin))
    {
        rstrip(line);
        if (line[0] == '\0')
        {
            continue;
        }

        if (strcmp(line, "init") == 0)
        {
            initialised = call_initialise();
            if (initialised)
            {
                printf("OK\n");
            }
            else
            {
                printf("ERR\n");
            }
            fflush(stdout);
            continue;
        }

        if (!initialised)
        {
            fprintf(stderr, "Not initialised\n");
            continue;
        }

        if (strncmp(line, "move ", 5) == 0)
        {
            int move = atoi(line + 5);
            char move_buf[32];
            snprintf(move_buf, sizeof(move_buf), "%d\n", move);
            if (send_move(move_buf))
            {
                printf("OK\n");
            }
            else
            {
                printf("ERR\n");
            }
            fflush(stdout);
            continue;
        }

        if (strcmp(line, "poll") == 0)
        {
            int pile = -1;
            int msg = receive_message(&pile);
            if (msg == GENERATE_MOVE)
            {
                printf("YOUR_TURN\n");
            }
            else if (msg == PLAY_MOVE)
            {
                printf("OPPONENT_MOVE %d\n", pile);
            }
            else if (msg == GAME_TERMINATION)
            {
                printf("GAME_OVER\n");
            }
            else
            {
                printf("UNKNOWN %d\n", msg);
            }
            fflush(stdout);
            continue;
        }

        if (strcmp(line, "quit") == 0)
        {
            break;
        }

        fprintf(stderr, "Unknown command: %s\n", line);
    }

    close_comms();
    return 0;
}
