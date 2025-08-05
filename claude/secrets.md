PS C:\Users\matth\projects\offers-and-asks-slack> git push
Enumerating objects: 24, done.
Counting objects: 100% (24/24), done.
Delta compression using up to 24 threads
Compressing objects: 100% (15/15), done.
Writing objects: 100% (16/16), 5.77 KiB | 2.88 MiB/s, done.
Total 16 (delta 8), reused 0 (delta 0), pack-reused 0 (from 0)
remote: Resolving deltas: 100% (8/8), completed with 5 local objects.
remote: error: GH013: Repository rule violations found for refs/heads/main.
remote:
remote: - GITHUB PUSH PROTECTION
remote: —————————————————————————————————————————
remote: Resolve the following violations before pushing again
remote:
remote: - Push cannot contain secrets
remote:
remote:
remote: (?) Learn how to resolve a blocked push
remote: https://docs.github.com/code-security/secret-scanning/working-with-secret-scanning-and-push-protection/working-with-push-protection-from-the-command-line#resolving-a-blocked-push
remote:
remote: (?) This repository does not have Secret Scanning enabled, but is eligible. Enable Secret Scanning to view and manage detected secrets.
remote: Visit the repository settings page, https://github.com/MattB543/offers-and-asks-slack/settings/security_analysis
remote:
remote:
remote: —— Aiven Service Password ————————————————————————————
remote: locations:
remote: - commit: 17160ba3b77424cfcd034884cbfaac72408190fe
remote: path: claude/improvement.md:6
remote: - commit: 17160ba3b77424cfcd034884cbfaac72408190fe
remote: path: claude/improvement.md:10
remote:
remote: (?) To push, remove secret from commit(s) or follow this URL to allow the secret.
remote: https://github.com/MattB543/offers-and-asks-slack/security/secret-scanning/unblock-secret/30sqiN7rX6U0Ag2GNPjZWtF3m81
remote:
remote:
remote:
To https://github.com/MattB543/offers-and-asks-slack.git
! [remote rejected] main -> main (push declined due to repository rule violations)
error: failed to push some refs to 'https://github.com/MattB543/offers-and-asks-slack.git'
PS C:\Users\matth\projects\offers-and-asks-slack>
