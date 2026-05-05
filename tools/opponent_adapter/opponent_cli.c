#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void opponent_initialise(int color);
void opponent_apply_move(char move[]);
void opponent_gen_move(char move[]);

static void rstrip(char *value)
{
    size_t len = strlen(value);
    while (len > 0 && (value[len - 1] == '\n' || value[len - 1] == '\r'))
    {
        value[len - 1] = '\0';
        len--;
    }
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

        if (strncmp(line, "init ", 5) == 0)
        {
            int color = atoi(line + 5);
            opponent_initialise(color);
            initialised = 1;
            printf("OK\n");
            fflush(stdout);
            continue;
        }

        if (!initialised)
        {
            fprintf(stderr, "Not initialised\n");
            continue;
        }

        if (strncmp(line, "apply ", 6) == 0)
        {
            int move = atoi(line + 6);
            char move_buf[32];
            snprintf(move_buf, sizeof(move_buf), "%d\n", move);
            opponent_apply_move(move_buf);
            printf("OK\n");
            fflush(stdout);
            continue;
        }

        if (strcmp(line, "gen") == 0)
        {
            char move_buf[32];
            opponent_gen_move(move_buf);
            rstrip(move_buf);
            printf("%s\n", move_buf);
            fflush(stdout);
            continue;
        }

        if (strcmp(line, "quit") == 0)
        {
            break;
        }

        fprintf(stderr, "Unknown command: %s\n", line);
    }

    return 0;
}
