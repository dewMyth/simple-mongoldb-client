/**
 * Local port forward over SSH: 127.0.0.1:<random> → (ssh host) → targetHost:targetPort.
 */
import { createServer, type AddressInfo, type Server } from 'node:net'
import { readFile } from 'node:fs/promises'
import { Client, type ConnectConfig } from 'ssh2'
import type { SshConfig } from '@shared/connection'

export interface SshTunnel {
  localPort: number
  close(): Promise<void>
}

export interface SshSecrets {
  sshPassword?: string
  sshPassphrase?: string
}

export async function openSshTunnel(
  ssh: SshConfig,
  secrets: SshSecrets,
  target: { host: string; port: number },
  timeoutMs = 15_000
): Promise<SshTunnel> {
  const config: ConnectConfig = {
    host: ssh.host,
    port: ssh.port,
    username: ssh.username,
    readyTimeout: timeoutMs,
    keepaliveInterval: 10_000
  }
  if (ssh.authMethod === 'password') {
    config.password = secrets.sshPassword
  } else {
    if (!ssh.privateKeyFile) throw new Error('SSH private key file is required')
    config.privateKey = await readFile(ssh.privateKeyFile)
    if (secrets.sshPassphrase) config.passphrase = secrets.sshPassphrase
  }

  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve())
    client.once('error', (err) =>
      reject(new Error(`SSH connection to ${ssh.host}:${ssh.port} failed: ${err.message}`))
    )
    client.connect(config)
  })

  const server: Server = createServer((socket) => {
    client.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) => {
      if (err) {
        socket.destroy(err)
        return
      }
      socket.pipe(stream).pipe(socket)
      socket.on('error', () => stream.destroy())
      stream.on('error', () => socket.destroy())
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  return {
    localPort: (server.address() as AddressInfo).port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      client.end()
    }
  }
}
