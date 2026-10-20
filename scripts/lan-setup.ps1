# Run on the SERVER PC (right-click PowerShell -> Run as administrator) so cashier PCs can connect.
# Opens TCP port 4010 for the Private network profile and prints the address to enter on the terminals.
#
#   -Tailscale   Development testing only (the store runs on its local network and needs no internet).
#                Also lets devices in your Tailscale network (100.64.0.0/10) reach the API on any network profile,
#                for teammates who connect over Tailscale. Windows Firewall stays on; only port 4010 is opened,
#                and only to Tailscale addresses.
param([int]$Port = 4010, [switch]$Tailscale)

$rule = "9010 POS API"
if (-not (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null
  Write-Host "Firewall: opened TCP $Port (Private networks)."
} else {
  Write-Host "Firewall: rule '$rule' already exists."
}

if ($Tailscale) {
  $tsRule = "9010 POS API (Tailscale)"
  if (-not (Get-NetFirewallRule -DisplayName $tsRule -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $tsRule -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress 100.64.0.0/10 -Action Allow -Profile Any | Out-Null
    Write-Host "Firewall: opened TCP $Port to Tailscale addresses only (100.64.0.0/10)."
  } else {
    Write-Host "Firewall: rule '$tsRule' already exists."
  }
  $tsIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '100.*' } | Select-Object -First 1).IPAddress
  if ($tsIp) {
    Write-Host "`nTailscale address for teammates (their SERVER_HOST): $tsIp"
  } else {
    Write-Host "`nNo Tailscale address found. Install Tailscale, sign in, and run this again."
  }
}

Write-Host "`nServer addresses (use one on the terminal as SERVER_HOST):"
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|VirtualBox|VMware|Loopback' } |
  ForEach-Object { Write-Host ("  {0,-16} {1}" -f $_.IPAddress, $_.InterfaceAlias) }
Write-Host "`nNote: if the PCs are joined by a LAN cable with no router, Windows assigns 169.254.x.x addresses;"
Write-Host "set static IPs (e.g. 192.168.50.1 and 192.168.50.2, mask 255.255.255.0) on both Ethernet adapters first."
