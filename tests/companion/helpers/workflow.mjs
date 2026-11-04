// SPDX-License-Identifier: AGPL-3.0-only
import { Workflow as CoreWorkflow } from '../../../companion/workflow.mjs'
import { Configuration } from '../../../companion/configuration.mjs'
import { Metadata } from '../../../companion/metadata.mjs'
import { Transfers } from '../../../companion/transfers.mjs'
import { DocumentTrash } from '../../../companion/document-trash.mjs'
import { FiledLocations } from '../../../companion/locations.mjs'
import { SimilarDocuments } from '../../../companion/similarity.mjs'
import { Conversions } from '../../../companion/conversions.mjs'
import { Intake } from '../../../companion/intake.mjs'
import { Automation } from '../../../companion/automation.mjs'
export class Workflow extends CoreWorkflow {
  constructor(journal) {
    super(journal)
    const metadata = new Metadata(this),
      intake = new Intake(this)
    const services = {
      metadata,
      intake,
      configuration: new Configuration(this),
      transfers: new Transfers(this),
      documentTrash: new DocumentTrash(this),
      locations: new FiledLocations(this),
      similarities: new SimilarDocuments(this),
      conversions: new Conversions(this),
      automation: new Automation(this, metadata, intake)
    }
    for (const [name, value] of Object.entries(services))
      Object.defineProperty(this, name, { value, writable: true, configurable: true })
  }
}
