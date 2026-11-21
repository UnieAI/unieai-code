# `unieai kube` — kubectl access to UnieAI Studio vClusters

UnieAI Studio gives each person their own, short-lived Kubernetes credentials for
the vClusters they have access to (the equivalent of `aws eks get-token`).
`unieai kube` is the kubectl side of that.

## Use it

```shell
unieai login --studio https://<your Studio>     # once, the usual Studio sign-in
unieai kube kubeconfig <vClusterId>             # writes vcluster-<id>-exec.yaml
export KUBECONFIG=$PWD/vcluster-<vClusterId>-exec.yaml
kubectl get pods
```

`-o <file>` writes the kubeconfig elsewhere, `-o -` prints it. The same file can be
downloaded from the vCluster's **Access** tab in Studio.

## How it works

- The kubeconfig's user is an exec credential plugin:
  `unieai kube token --cluster <id> --studio <url>`. It contains no token.
- `kube token` reads the Studio sign-in stored by `unieai login` (refreshing it
  when needed), calls `POST <studio>/api/on-prem/clusters/<id>/access/token`, and
  prints the `client.authentication.k8s.io/v1` ExecCredential kubectl expects.
- Tokens are cached per vCluster under `$CODEX_HOME/unieai-kube/` (directory 0700,
  files 0600) and reused until a minute before they expire (tokens last 15 minutes).
- `unieai kube kubeconfig` calls `GET <studio>/api/on-prem/clusters/<id>/access/kubeconfig`
  with the same sign-in. For a vCluster on a private network, Studio points the
  kubeconfig at the platform's connection relay.
- While Studio is still applying a newly granted role it answers 409; the plugin
  retries for about 30 seconds.
- `unieai kube logout` deletes cached tokens. `unieai logout` signs out of Studio and
  deletes them too. A cached token is only reused by the account (or machine key) it
  was issued to.

## CI

Set `UNIEAI_MACHINE_KEY` to a project machine identity's exchange key. `kube token` then
sends that key instead of reading a sign-in, and needs `--studio` (the kubeconfig from
Studio already passes it). Its tokens are cached separately from personal ones.

## Errors

Messages are printed on stderr, so kubectl shows them:

| Message | What to do |
|---|---|
| Not signed in to UnieAI Studio | `unieai login --studio <url>` (a Rabi sign-in does not count) |
| Your UnieAI Studio sign-in has expired | `unieai login` again |
| This kubeconfig belongs to X, but you are signed in to Y | `unieai login --studio X` |
| (Studio's message, e.g. no access to this vCluster) | ask whoever manages access in the project |
| vCluster … was not found | the vCluster was removed, or you are not in its project |
| … connection relay is not enabled | use Studio's web terminal, or ask the platform admin to enable the relay |
| … still being applied | try again in a minute |
| did not accept the machine identity key | the key is disabled, revoked or mistyped |
