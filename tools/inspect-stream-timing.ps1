param(
    [ValidateRange(1, 5)][int]$ChannelCount = 3,
    [string]$OutputPath = (Join-Path $PSScriptRoot '../research/stream-timing-2026-10-14.json')
)
$ErrorActionPreference = 'Stop'
$invariant = [Globalization.CultureInfo]::InvariantCulture

function Read-Playlist([string]$Address) {
    $uri = [Uri]$Address
    if ($uri.Scheme -ne 'https' -or $uri.Host -notmatch '(^|\.)pstatic\.net$') {
        throw 'Unexpected media host; only public pstatic.net playlists are inspected.'
    }
    $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 20 -Headers @{
        Origin = 'https://chzzk.naver.com'; Referer = 'https://chzzk.naver.com/'
    }
    $body = $response.Content
    if ($body -is [byte[]]) { $body = [Text.Encoding]::UTF8.GetString($body) }
    if ($body -notmatch '^\s*#EXTM3U') { throw 'Response is not an HLS playlist.' }
    [pscustomobject]@{
        Uri = $uri; Lines = @($body -split '\r?\n')
        ObservedAt = [DateTimeOffset]::UtcNow
        ServerDate = [string]($response.Headers['Date'] -join ', ')
        CacheAge = [string]($response.Headers['Age'] -join ', ')
    }
}

function Read-Variant($Playlist) {
    for ($i = 0; $i -lt $Playlist.Lines.Count; $i++) {
        if ($Playlist.Lines[$i] -notmatch '^#EXT-X-STREAM-INF:') { continue }
        for ($j = $i + 1; $j -lt $Playlist.Lines.Count; $j++) {
            $line = $Playlist.Lines[$j].Trim()
            if (-not $line -or $line.StartsWith('#')) { continue }
            return Read-Playlist ([Uri]::new($Playlist.Uri, $line).AbsoluteUri)
        }
    }
    return $Playlist
}

function Get-TimingSummary($Playlist) {
    $anchors = @($Playlist.Lines | Where-Object { $_ -match '^#EXT-X-PROGRAM-DATE-TIME:' })
    $parts = @($Playlist.Lines | Where-Object { $_ -match '^#EXT-X-PART:' })
    $nextSegmentTime = $null
    $latestMediaTime = $null
    $pendingDuration = $null
    $trailingParts = 0.0
    $segmentCount = 0
    $datedSegmentCount = 0
    foreach ($line in $Playlist.Lines) {
        if ($line -match '^#EXT-X-PROGRAM-DATE-TIME:(.+)$') {
            $nextSegmentTime = [DateTimeOffset]::Parse($Matches[1], $invariant)
            $trailingParts = 0.0
        } elseif ($line -match '^#EXT-X-PART:.*?DURATION=([0-9.]+)') {
            $trailingParts += [double]::Parse($Matches[1], $invariant)
            if ($null -ne $nextSegmentTime) {
                $latestMediaTime = $nextSegmentTime.AddSeconds($trailingParts)
            }
        } elseif ($line -match '^#EXTINF:([0-9.]+)') {
            $pendingDuration = [double]::Parse($Matches[1], $invariant)
        } elseif ($line.Trim() -and -not $line.StartsWith('#') -and $null -ne $pendingDuration) {
            $segmentCount++
            if ($null -ne $nextSegmentTime) {
                $datedSegmentCount++
                $nextSegmentTime = $nextSegmentTime.AddSeconds($pendingDuration)
                $latestMediaTime = $nextSegmentTime
            }
            $pendingDuration = $null
            $trailingParts = 0.0
        }
    }
    [pscustomobject]@{
        observedAtUtc = $Playlist.ObservedAt.ToString('o')
        host = $Playlist.Uri.Host
        serverDate = $Playlist.ServerDate
        cacheAge = $Playlist.CacheAge
        programDateTimeTagCount = $anchors.Count
        firstProgramDateTimeTag = if ($anchors.Count) { $anchors[0] } else { $null }
        lastProgramDateTimeTag = if ($anchors.Count) { $anchors[-1] } else { $null }
        segmentCount = $segmentCount
        segmentsWithMappedTime = $datedSegmentCount
        partCount = $parts.Count
        targetDurationTag = @($Playlist.Lines | Where-Object { $_ -match '^#EXT-X-TARGETDURATION:' }) -join ''
        serverControlTag = @($Playlist.Lines | Where-Object { $_ -match '^#EXT-X-SERVER-CONTROL:' }) -join ''
        latestAdvertisedMediaTimeUtc = if ($null -ne $latestMediaTime) { $latestMediaTime.ToUniversalTime().ToString('o') } else { $null }
        advertisedEdgeAgeSeconds = if ($null -ne $latestMediaTime) {
            [Math]::Round(($Playlist.ObservedAt - $latestMediaTime).TotalSeconds, 3)
        } else { $null }
    }
}

$list = Invoke-RestMethod -Uri ('https://api.chzzk.naver.com/service/v1/lives?size=' + $ChannelCount) -TimeoutSec 20
$results = @()
foreach ($live in $list.content.data | Select-Object -First $ChannelCount) {
    $channelId = [string]$live.channel.channelId
    if ($channelId -notmatch '^[0-9a-f]{32}$') { continue }
    $detail = Invoke-RestMethod -Uri ('https://api.chzzk.naver.com/service/v3/channels/' + $channelId + '/live-detail') -TimeoutSec 20
    $playback = $detail.content.livePlaybackJson | ConvertFrom-Json
    foreach ($entry in $playback.media) {
        if ($entry.mediaId -notin @('HLS', 'LLHLS')) { continue }
        try {
            $master = Read-Playlist $entry.path
            $variant = Read-Variant $master
            $results += [pscustomobject]@{
                channelId = $channelId; liveId = $detail.content.liveId
                status = $detail.content.status; mediaId = $entry.mediaId
                variantSelection = 'first listed video variant'
                timing = Get-TimingSummary $variant
            }
        } catch {
            # Do not include signed URLs or full server exception messages.
            $results += [pscustomobject]@{
                channelId = $channelId; liveId = $detail.content.liveId
                mediaId = $entry.mediaId; error = 'Playlist inspection failed'
                errorType = $_.Exception.GetType().Name
            }
        }
    }
}
$report = [pscustomobject]@{
    checkedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    scope = 'Public live API and one video rendition per HLS/LLHLS entry; no media segments downloaded'
    limitations = @('PDT origin is not verified as camera capture time',
        'This does not identify the active Firefox playback route',
        'Edge age depends on client and stream clock alignment and is not glass-to-glass latency')
    results = $results
}
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($resolvedOutput)) -Force | Out-Null
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedOutput -Encoding utf8
$report | ConvertTo-Json -Depth 8
