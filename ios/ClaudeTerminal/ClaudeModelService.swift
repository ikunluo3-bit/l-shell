import Foundation

enum ClaudeModelService {
    static func fetchModels(baseURL: String,
                            credential: String,
                            authMode: ClaudeAuthMode) async throws -> [String] {
        let url = try modelsURL(from: baseURL)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        if !credential.isEmpty {
            switch authMode {
            case .apiKey:
                request.setValue(credential, forHTTPHeaderField: "x-api-key")
            case .oauthToken:
                request.setValue("Bearer \(credential)", forHTTPHeaderField: "authorization")
            }
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse,
           !(200..<300).contains(http.statusCode) {
            throw URLError(.badServerResponse)
        }
        let object = try JSONSerialization.jsonObject(with: data)
        return parseModelIDs(from: object)
    }

    private static func modelsURL(from baseURL: String) throws -> URL {
        var raw = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { raw = "https://api.anthropic.com" }
        while raw.hasSuffix("/") { raw.removeLast() }
        if raw.hasSuffix("/v1/messages") {
            raw.removeLast("/messages".count)
            raw += "/models"
        } else if !raw.hasSuffix("/v1/models") {
            raw += raw.hasSuffix("/v1") ? "/models" : "/v1/models"
        }
        guard let url = URL(string: raw) else { throw URLError(.badURL) }
        return url
    }

    private static func parseModelIDs(from object: Any) -> [String] {
        var ids: [String] = []
        func append(_ value: Any?) {
            guard let id = value as? String, !id.isEmpty, !ids.contains(id) else { return }
            ids.append(id)
        }

        if let dict = object as? [String: Any] {
            if let data = dict["data"] as? [[String: Any]] {
                for item in data { append(item["id"]) }
            }
            if let models = dict["models"] as? [[String: Any]] {
                for item in models { append(item["id"]) }
            }
            if let idsArray = dict["models"] as? [String] {
                for id in idsArray { append(id) }
            }
        } else if let array = object as? [[String: Any]] {
            for item in array { append(item["id"]) }
        } else if let array = object as? [String] {
            for id in array { append(id) }
        }

        return ids.sorted()
    }
}
