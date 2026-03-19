import { authenticator } from "otplib"

export function generateGitHubTotp(secret: string): string {
  return authenticator.generate(secret.trim())
}
