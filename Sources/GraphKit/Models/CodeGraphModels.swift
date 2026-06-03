import Foundation
import CoreGraphics

public enum CGNodeKind: String, Sendable, Hashable {
    case file, symbol, module, docPage
    case memoryDoc, memoryChunk
    case noteDecision, noteTask, noteQuestion, noteFact
    case noteConcept, notePlaybook, noteHypothesis, noteEvent, noteSource
    case function, classType, config, service, table, endpoint
    case pipeline, schemaNode, resource, domain, flow, step
    case article, entity, topic, claim
    case other
}

public extension CGNodeKind {
    /// All atomic-note kinds, in display order.
    static let atomicNoteKinds: [CGNodeKind] = [
        .noteDecision, .noteTask, .noteQuestion, .noteFact,
        .noteConcept, .notePlaybook, .noteHypothesis, .noteEvent, .noteSource
    ]

    var displayName: String {
        switch self {
        case .file:           return "File"
        case .symbol:         return "Symbol"
        case .module:         return "Module"
        case .docPage:        return "Doc"
        case .memoryDoc:      return "Document"
        case .memoryChunk:    return "Note"
        case .noteDecision:   return "Decision"
        case .noteTask:       return "Task"
        case .noteQuestion:   return "Question"
        case .noteFact:       return "Fact"
        case .noteConcept:    return "Concept"
        case .notePlaybook:   return "Playbook"
        case .noteHypothesis: return "Hypothesis"
        case .noteEvent:      return "Event"
        case .noteSource:     return "Source"
        case .function:       return "Function"
        case .classType:      return "Class"
        case .config:         return "Config"
        case .service:        return "Service"
        case .table:          return "Table"
        case .endpoint:       return "Endpoint"
        case .pipeline:       return "Pipeline"
        case .schemaNode:     return "Schema"
        case .resource:       return "Resource"
        case .domain:         return "Domain"
        case .flow:           return "Flow"
        case .step:           return "Step"
        case .article:        return "Article"
        case .entity:         return "Entity"
        case .topic:          return "Topic"
        case .claim:          return "Claim"
        case .other:          return "Other"
        }
    }

    /// Map a vault `NodeType` raw value to the matching `CGNodeKind`.
    /// Allows the Knowledge Graph to share the same canvas and palette as
    /// the Code Graph without changing the underlying notes data model.
    static func from(_ rawValue: String) -> CGNodeKind {
        switch rawValue {
        case "decision":    return .noteDecision
        case "concept":     return .noteConcept
        case "question":    return .noteQuestion
        case "task":        return .noteTask
        case "hypothesis":  return .noteHypothesis
        case "fact":        return .noteFact
        case "source":      return .noteSource
        case "playbook":    return .notePlaybook
        case "event":       return .noteEvent
        case "pillar":      return .domain
        case "pattern":     return .notePlaybook
        case "bookmark":    return .noteSource
        case "note":        return .memoryChunk
        case "contact":     return .entity
        case "reference":   return .noteSource
        case "custom":      return .other
        case "code_file":   return .file
        case "code_symbol": return .symbol
        case "code_module": return .module
        case "doc_page":    return .docPage
        default:            return .other
        }
    }

    /// Kinds shown in the Knowledge Graph legend (vault note types only).
    static let knowledgeGraphKinds: [CGNodeKind] = [
        .domain, .noteDecision, .noteConcept, .noteQuestion,
        .noteTask, .noteHypothesis, .noteFact, .noteSource,
        .notePlaybook, .noteEvent, .memoryChunk, .entity, .other
    ]
}

public enum CGEdgeKind: String, Sendable, Hashable {
    case imports, exports, contains, inherits, implements
    case calls, subscribes, publishes, middleware
    case readsFrom, writesTo, transforms, validates
    case dependsOn, testedBy, configures
    case relatedTo, similarTo
    case deploys, serves, provisions, triggers
    case migrates, documents, routes, definesSchema
    case containsFlow, flowStep, crossDomain
    case cites, contradicts, buildsOn, exemplifies, categorizedUnder, authoredBy
    case defines, references
}

public struct CGNode: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let kind: CGNodeKind
    public var position: CGPoint
    public let metadata: [String: String]

    public init(id: String, title: String, kind: CGNodeKind,
                position: CGPoint = .zero,
                metadata: [String: String] = [:]) {
        self.id = id; self.title = title; self.kind = kind
        self.position = position; self.metadata = metadata
    }
}

public enum CGEdgeConfidence: String, Sendable, Hashable {
    /// Explicitly stated in source code — 100% reliable.
    case extracted = "EXTRACTED"
    /// Reasonably deduced (e.g. call sites) — ~80% reliable.
    case inferred  = "INFERRED"
    /// Uncertain (dynamic dispatch, reflection) — 50–70% reliable.
    case ambiguous = "AMBIGUOUS"
}

public struct CGEdge: Equatable, Sendable {
    public let fromId: String
    public let toId: String
    public let kind: CGEdgeKind
    public let confidence: CGEdgeConfidence

    public init(fromId: String, toId: String, kind: CGEdgeKind,
                confidence: CGEdgeConfidence = .extracted) {
        self.fromId = fromId; self.toId = toId; self.kind = kind
        self.confidence = confidence
    }
}

public struct UALayer: Equatable, Sendable {
    public let id: String
    public let name: String
    public let nodeIds: [String]

    public init(id: String, name: String, nodeIds: [String]) {
        self.id = id; self.name = name; self.nodeIds = nodeIds
    }
}

public struct UATourStep: Equatable, Sendable {
    public let nodeId: String
    public let title: String
    public let body: String

    public init(nodeId: String, title: String, body: String) {
        self.nodeId = nodeId; self.title = title; self.body = body
    }
}

public struct CGData: Equatable, Sendable {
    public let nodes: [CGNode]
    public let edges: [CGEdge]
    public let layers: [UALayer]
    public let tour: [UATourStep]

    public init(nodes: [CGNode], edges: [CGEdge],
                layers: [UALayer] = [], tour: [UATourStep] = []) {
        self.nodes = nodes; self.edges = edges
        self.layers = layers; self.tour = tour
    }
    public static let empty = CGData(nodes: [], edges: [])
}
