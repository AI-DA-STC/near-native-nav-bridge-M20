import { describe, expect, it } from 'vitest'
import { placeOf, plainText, promptAtEnd, splitFinished } from './shell-prompt.ts'

describe('plain text', () => {
  it('drops colours, titles and carriage returns', () => {
    expect(plainText('\x1b]0;user@host: ~\x07\x1b[01;32muser@host\x1b[00m:~$ ls\r\nfile\r\n')).toBe('user@host:~$ ls\nfile\n')
  })

  it('keeps an escape cut between two chunks until the next one', () => {
    expect(splitFinished('done\x1b[3')).toEqual(['done', '\x1b[3'])
    expect(splitFinished('done\x1b[32mok')).toEqual(['done\x1b[32mok', ''])
    expect(splitFinished('title\x1b]0;user@host')).toEqual(['title', '\x1b]0;user@host'])
  })
})

describe('the prompt a terminal ends with', () => {
  const laptop = 'krishna-ws'

  it.each([
    ['root@krishna-ws:~/ros2_ws/src/nav_cmd_bridge# ', 'laptop'],
    ['Last login: Wed Jun 19\nuser@host.v1.4:~$ ', 'robot-user'],
    ['su\nPassword: \nroot@host.v1.4:/home/user# ', 'robot-root'],
    ['docker compose exec nav_cmd_bridge bash\nroot@host.v1.4:~/ros2_ws# ', 'container'],
    ['root@host.v1.4:/root/ros2_ws# ', 'container'],
    // ros2 topic hz ends on Ctrl+C without a newline: the prompt follows the echoed ^C
    ['average rate: 9.996\n^Croot@krishna-ws:~/ros2_ws/src/nav_cmd_bridge# ', 'laptop'],
  ])('%j is %s', (text, place) => {
    expect(placeOf(promptAtEnd(text)!, laptop)).toBe(place)
  })

  it('none while a program prints, or before the prompt’s space', () => {
    expect(promptAtEnd('[INFO] [launch]: All log files can be found below /root/.ros/log\n')).toBeNull()
    expect(promptAtEnd("user@192.168.123.100's password: ")).toBeNull()
    expect(promptAtEnd('root@host.v1.4:/home/user#')).toBeNull()
    expect(promptAtEnd('root@host.v1.4:/home/user# docker ps')).toBeNull()
  })
})
