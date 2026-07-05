#!/usr/bin/env swift

import Foundation

private let metadataWaitSeconds: TimeInterval = 4
private let dataVolumePrefix = "/System/Volumes/Data"

private func normalizedDirectoryPrefix(_ path: String) -> String {
  path.hasSuffix("/") ? path : path + "/"
}

private func metadataPathPrefixes(for expandedPath: String) -> [String] {
  let userPrefix = normalizedDirectoryPrefix(expandedPath)
  if expandedPath.hasPrefix(dataVolumePrefix) {
    return [userPrefix]
  }

  return [userPrefix, normalizedDirectoryPrefix(dataVolumePrefix + expandedPath)]
}

private func firstChildName(from metadataPath: String, parentPrefixes: [String]) -> String? {
  for prefix in parentPrefixes {
    guard metadataPath.hasPrefix(prefix) else {
      continue
    }

    let remainder = String(metadataPath.dropFirst(prefix.count))
    guard let firstComponent = remainder.split(separator: "/").first.map(String.init),
          !firstComponent.isEmpty else {
      continue
    }

    return firstComponent
  }

  return nil
}

private func downloadPaths(_ paths: [String]) {
  let fileManager = FileManager.default
  for rawPath in paths {
    let path = (rawPath as NSString).expandingTildeInPath
    let url = URL(fileURLWithPath: path, isDirectory: true)
    guard fileManager.fileExists(atPath: path) else {
      continue
    }
    try? fileManager.startDownloadingUbiquitousItem(at: url)
  }
}

private func listViaFileManager(parentPath: String) -> [String] {
  let fileManager = FileManager.default
  let path = (parentPath as NSString).expandingTildeInPath
  guard fileManager.fileExists(atPath: path) else {
    return []
  }

  guard let contents = try? fileManager.contentsOfDirectory(
    at: URL(fileURLWithPath: path, isDirectory: true),
    includingPropertiesForKeys: [.isDirectoryKey],
    options: [.skipsHiddenFiles]
  ) else {
    return []
  }

  return contents.compactMap { url -> String? in
    let values = try? url.resourceValues(forKeys: [.isDirectoryKey])
    guard values?.isDirectory == true else {
      return nil
    }
    return url.lastPathComponent
  }
}

private final class MetadataPathCollector {
  private let lock = NSLock()
  private var storage: [String] = []

  var paths: [String] {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  func collect(from query: NSMetadataQuery) {
    var found: [String] = []
    found.reserveCapacity(query.resultCount)
    for index in 0..<query.resultCount {
      guard let item = query.result(at: index) as? NSMetadataItem,
            let path = item.value(forAttribute: NSMetadataItemPathKey) as? String else {
        continue
      }
      found.append(path)
    }

    lock.lock()
    storage = found
    lock.unlock()
  }
}

private func fetchUbiquitousPaths(parentPrefixes: [String]) -> [String] {
  let collector = MetadataPathCollector()
  let semaphore = DispatchSemaphore(value: 0)
  let scopes = [
    NSMetadataQueryUbiquitousDocumentsScope,
    NSMetadataQueryUbiquitousDataScope,
  ]

  DispatchQueue.main.async {
    let query = NSMetadataQuery()
    query.searchScopes = scopes
    let prefixPredicates = parentPrefixes.map {
      NSPredicate(
        format: "%K BEGINSWITH[c] %@",
        NSMetadataItemPathKey,
        $0
      )
    }
    query.predicate = NSCompoundPredicate(orPredicateWithSubpredicates: prefixPredicates)

    var gatheringObserver: NSObjectProtocol?
    var updateObserver: NSObjectProtocol?
    var stopped = false

    func stopQuery() {
      guard !stopped else {
        return
      }
      stopped = true
      query.disableUpdates()
      collector.collect(from: query)
      query.stop()
      if let gatheringObserver {
        NotificationCenter.default.removeObserver(gatheringObserver)
      }
      if let updateObserver {
        NotificationCenter.default.removeObserver(updateObserver)
      }
      semaphore.signal()
    }

    updateObserver = NotificationCenter.default.addObserver(
      forName: .NSMetadataQueryDidUpdate,
      object: query,
      queue: OperationQueue()
    ) { _ in
      query.disableUpdates()
      collector.collect(from: query)
      query.enableUpdates()
    }

    gatheringObserver = NotificationCenter.default.addObserver(
      forName: .NSMetadataQueryDidFinishGathering,
      object: query,
      queue: OperationQueue()
    ) { _ in
      query.disableUpdates()
      collector.collect(from: query)
      query.enableUpdates()
    }

    query.start()

    DispatchQueue.main.asyncAfter(deadline: .now() + metadataWaitSeconds) {
      stopQuery()
    }
  }

  _ = semaphore.wait(timeout: .now() + metadataWaitSeconds + 1)
  return collector.paths
}

private func listChildren(parentPath: String) -> [String] {
  let expanded = (parentPath as NSString).expandingTildeInPath
  downloadPaths([expanded])

  var results = Set(listViaFileManager(parentPath: expanded))
  let parentPrefixes = metadataPathPrefixes(for: expanded)
  let metadataPaths = fetchUbiquitousPaths(parentPrefixes: parentPrefixes)
  let userParentPrefix = normalizedDirectoryPrefix(expanded)

  for path in metadataPaths {
    guard let firstComponent = firstChildName(from: path, parentPrefixes: parentPrefixes) else {
      continue
    }

    // iCloud items can appear in metadata before the folder exists locally.
    results.insert(firstComponent)
    let childPath = userParentPrefix + firstComponent
    let childUrl = URL(fileURLWithPath: childPath, isDirectory: true)
    try? FileManager.default.startDownloadingUbiquitousItem(at: childUrl)
  }

  return Array(results).sorted()
}

private func printJSON<T: Encodable>(_ value: T) {
  let encoder = JSONEncoder()
  guard let data = try? encoder.encode(value),
        let text = String(data: data, encoding: .utf8) else {
    fputs("[]\n", stdout)
    return
  }
  fputs(text + "\n", stdout)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
  fputs("usage: icloud-refresh <refresh|download|list-children|read-file|write-file|check-signed-in> ...\n", stderr)
  exit(64)
}

switch command {
case "refresh":
  let paths = Array(args.dropFirst())
  downloadPaths(paths)
  for rawPath in paths {
    let expanded = (rawPath as NSString).expandingTildeInPath
    _ = fetchUbiquitousPaths(parentPrefixes: metadataPathPrefixes(for: expanded))
  }
  fputs("ok\n", stdout)

case "list-children":
  guard let parentPath = args.dropFirst().first else {
    fputs("usage: icloud-refresh list-children <parent-path>\n", stderr)
    exit(64)
  }
  printJSON(listChildren(parentPath: parentPath))

case "check-signed-in":
  let signedIn = FileManager.default.ubiquityIdentityToken != nil
  fputs(signedIn ? "yes\n" : "no\n", stdout)

case "write-file":
  guard let filePath = args.dropFirst().first else {
    fputs("usage: icloud-refresh write-file <path> (content on stdin)\n", stderr)
    exit(64)
  }
  let expandedWritePath = (filePath as NSString).expandingTildeInPath
  let writeData = FileHandle.standardInput.readDataToEndOfFile()
  let writeUrl = URL(fileURLWithPath: expandedWritePath)
  let parentUrl = writeUrl.deletingLastPathComponent()
  try? FileManager.default.startDownloadingUbiquitousItem(at: parentUrl)
  try? FileManager.default.createDirectory(at: parentUrl, withIntermediateDirectories: true)
  try? FileManager.default.startDownloadingUbiquitousItem(at: writeUrl)
  let writeOk = FileManager.default.createFile(atPath: expandedWritePath, contents: writeData)
  fputs(writeOk ? "ok\n" : "fail\n", stdout)
  if !writeOk {
    exit(1)
  }

case "read-file":
  guard let filePath = args.dropFirst().first else {
    fputs("usage: icloud-refresh read-file <path>\n", stderr)
    exit(64)
  }
  let expandedReadPath = (filePath as NSString).expandingTildeInPath
  let readUrl = URL(fileURLWithPath: expandedReadPath)
  let readParentUrl = readUrl.deletingLastPathComponent()
  try? FileManager.default.startDownloadingUbiquitousItem(at: readParentUrl)
  try? FileManager.default.startDownloadingUbiquitousItem(at: readUrl)
  guard FileManager.default.fileExists(atPath: expandedReadPath) else {
    exit(0)
  }
  guard let readData = try? Data(contentsOf: readUrl),
        let readText = String(data: readData, encoding: .utf8) else {
    exit(1)
  }
  fputs(readText, stdout)

case "download":
  var downloadPathsList = Array(args.dropFirst())
  var waitSeconds: TimeInterval = 4
  if let last = downloadPathsList.last,
     let parsed = TimeInterval(last),
     last.allSatisfy({ $0.isNumber || $0 == "." }) {
    waitSeconds = parsed
    downloadPathsList.removeLast()
  }
  downloadPaths(downloadPathsList)
  let downloadDeadline = Date().addingTimeInterval(waitSeconds)
  var pendingPaths = downloadPathsList.map { ($0 as NSString).expandingTildeInPath }
  while Date() < downloadDeadline && !pendingPaths.isEmpty {
    pendingPaths = pendingPaths.filter { path in
      if FileManager.default.fileExists(atPath: path) {
        return false
      }
      let url = URL(fileURLWithPath: path)
      try? FileManager.default.startDownloadingUbiquitousItem(at: url)
      try? FileManager.default.startDownloadingUbiquitousItem(at: url.deletingLastPathComponent())
      return true
    }
    if pendingPaths.isEmpty {
      break
    }
    Thread.sleep(forTimeInterval: 0.2)
  }
  fputs("ok\n", stdout)

default:
  fputs("unknown command: \(command)\n", stderr)
  exit(64)
}
