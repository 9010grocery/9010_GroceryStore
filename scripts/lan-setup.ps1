# Run on the SERVER PC (right-click PowerShell -> Run as administrator) so cashier PCs can connect.
# Opens TCP port 4010 for the Private network profile and prints the address to enter on the terminals.
param([int]$Port = 4010)

$rule = "9010 POS API"
if (-not (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null
  Write-Host "Firewall: opened TCP $Port (Private networks)."
} else {
  Write-Host "Firewall: rule '$rule' already exists."
}

Write-Host "`nServer addresses (use one on the terminal as SERVER_HOST):"
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|VirtualBox|VMware|Loopback' } |
  ForEach-Object { Write-Host ("  {0,-16} {1}" -f $_.IPAddress, $_.InterfaceAlias) }
Write-Host "`nNote: if the PCs are joined by a LAN cable with no router, Windows assigns 169.254.x.x addresses;"
Write-Host "set static IPs (e.g. 192.168.50.1 and 192.168.50.2, mask 255.255.255.0) on both Ethernet adapters first."
