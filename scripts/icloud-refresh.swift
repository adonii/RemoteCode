#!/usr/bin/env swift

import Foundation

private let metadataWaitSeconds: TimeInterval = 1.5

private func normalizedDirectoryPrefix(_ path: String) -> String {
  path.hasSuffix("/") ? path : path + "/"
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

private func fetchUbiquitousPaths(prefix: String) -> [String] {
  let collector = MetadataPathCollector()
  let semaphore = DispatchSemaphore(value: 0)

  DispatchQueue.main.async {
    let query = NSMetadataQuery()
    query.searchScopes = [NSMetadataQueryUbiquitousDocumentsScope]
    query.predicate = NSPredicate(
      format: "%K BEGINSWITH[c] %@",
      NSMetadataItemPathKey,
      prefix
    )

    var observer: NSObjectProtocol?
    observer = NotificationCenter.default.addObserver(
      forName: .NSMetadataQueryDidFinishGathering,
      object: query,
      queue: OperationQueue()
    ) { _ in
      query.disableUpdates()
      collector.collect(from: query)
      query.stop()
      if let observer {
        NotificationCenter.default.removeObserver(observer)
      }
      semaphore.signal()
    }

    query.start()
  }

  _ = semaphore.wait(timeout: .now() + metadataWaitSeconds)
  return collector.paths
}

private func listChildren(parentPath: String) -> [String] {
  let expanded = (parentPath as NSString).expandingTildeInPath
  downloadPaths([expanded])

  var results = Set(listViaFileManager(parentPath: expanded))
  let parentPrefix = normalizedDirectoryPrefix(expanded)
  let metadataPaths = fetchUbiquitousPaths(prefix: parentPrefix)

  for path in metadataPaths {
    guard path.hasPrefix(parentPrefix) else {
      continue
    }

    let remainder = String(path.dropFirst(parentPrefix.count))
    guard let firstComponent = remainder.split(separator: "/").first.map(String.init),
          !firstComponent.isEmpty else {
      continue
    }

    let childPath = parentPrefix + firstComponent
    if FileManager.default.fileExists(atPath: childPath) {
      results.insert(firstComponent)
    }
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
  fputs("usage: icloud-refresh <refresh|list-children> ...\n", stderr)
  exit(64)
}

switch command {
case "refresh":
  downloadPaths(Array(args.dropFirst()))
  if let prefix = args.dropFirst().first {
    let expanded = (prefix as NSString).expandingTildeInPath
    _ = fetchUbiquitousPaths(prefix: normalizedDirectoryPrefix(expanded))
  }
  fputs("ok\n", stdout)

case "list-children":
  guard let parentPath = args.dropFirst().first else {
    fputs("usage: icloud-refresh list-children <parent-path>\n", stderr)
    exit(64)
  }
  printJSON(listChildren(parentPath: parentPath))

default:
  fputs("unknown command: \(command)\n", stderr)
  exit(64)
}
