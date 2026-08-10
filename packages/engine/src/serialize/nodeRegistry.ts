// Which class a saved node's name refers to.
//
// A document names its nodes with strings, and something has to turn 'Rect' back into the Rect
// constructor. A registry rather than a switch, because the set is open: an application's own
// CustomShape subclasses are nodes like any other and have to round-trip through the same
// reader, and a switch in the engine could never know about them.
//
// The engine's own classes register themselves here at module load, so importing anything from
// serialize/ is enough to read a document made of built-ins.

import type { Node, NodeOptions } from '../shapes/Node'
import { Circle } from '../shapes/Circle'
import { Container } from '../shapes/Container'
import { Group } from '../shapes/Group'
import { Image } from '../shapes/Image'
import { Layer } from '../shapes/Layer'
import { MSDFText } from '../shapes/MSDFText'
import { Path } from '../shapes/Path'
import { Polyline } from '../shapes/Polyline'
import { Rect } from '../shapes/Rect'
import { UniformMSDFText } from '../shapes/UniformMSDFText'
import { UniformVectorText } from '../shapes/UniformVectorText'
import { VectorText } from '../shapes/VectorText'

/**
 * Anything constructible from an options object - which every node in the engine is, and which
 * a subclass has to stay if it wants to be read back.
 *
 * The options are the node's own attributes: every class takes its attribute names as option
 * names, which is what lets a reader hand a saved attribute set straight to a constructor
 * without knowing anything about the class.
 */
export type NodeConstructor = new (options: never) => Node

const registry = new Map<string, NodeConstructor>()

/**
 * Registers a class under the name its nodes report as `nodeName`, so a document naming it can
 * be read back. Registering a name twice replaces the first, which is what makes a subclass
 * able to take over a built-in name deliberately.
 *
 *   class Star extends CustomShape { override readonly nodeName = 'Star'; ... }
 *   registerNodeType('Star', Star)
 */
export function registerNodeType(name: string, constructor: NodeConstructor): void {
  registry.set(name, constructor)
}

/** The class registered under a name, or undefined. */
export function nodeTypeFor(name: string): NodeConstructor | undefined {
  return registry.get(name)
}

/** Every registered name, for a caller reporting what a document may contain. */
export function registeredNodeTypes(): string[] {
  return [...registry.keys()]
}

/**
 * Builds one node from a class name and an attribute set. Throws for a name nothing is
 * registered under, rather than dropping the node - a document that half-loads is worse than
 * one that says which class is missing.
 */
export function createNode(className: string, attrs: Readonly<Record<string, unknown>> = {}): Node {
  const constructor = nodeTypeFor(className)
  if (!constructor) {
    throw new Error(
      `createNode: nothing is registered under '${className}'. ` +
        `Call registerNodeType('${className}', TheClass) before reading a document that uses it.`,
    )
  }
  return new constructor({ ...attrs } as never as never)
}

// The built-ins. A bare Node is deliberately absent: it draws nothing and holds nothing, so a
// document containing one is almost always a Container that lost its class name.
registerNodeType('Container', Container as unknown as NodeConstructor)
registerNodeType('Group', Group as unknown as NodeConstructor)
registerNodeType('Layer', Layer as unknown as NodeConstructor)
registerNodeType('Rect', Rect as unknown as NodeConstructor)
registerNodeType('Circle', Circle as unknown as NodeConstructor)
registerNodeType('Polyline', Polyline as unknown as NodeConstructor)
registerNodeType('Path', Path as unknown as NodeConstructor)
registerNodeType('Image', Image as unknown as NodeConstructor)
registerNodeType('MSDFText', MSDFText as unknown as NodeConstructor)
registerNodeType('VectorText', VectorText as unknown as NodeConstructor)
registerNodeType('UniformMSDFText', UniformMSDFText as unknown as NodeConstructor)
registerNodeType('UniformVectorText', UniformVectorText as unknown as NodeConstructor)

/** Kept so the unused-import checker sees the option type this file's contract is written in. */
export type RegisteredNodeOptions = NodeOptions
