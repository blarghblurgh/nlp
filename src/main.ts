import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import compromise from "compromise";
import { normalizePath, Notice, Plugin, TFile } from "obsidian";
import { copy } from "obsidian-community-lib";
import model from "wink-eng-lite-web-model";
import winkNLP, {
	Bow,
	CustomEntityExample,
	Document,
	ItemEntity,
	ItemToken,
	WinkMethods,
} from "wink-nlp";
import { DEFAULT_SETTINGS, ENTITIES, TEXT_MANIPULATION_CMDS } from "./const";
import { Sentiment, Settings } from "./interfaces";
import { MarkupModal } from "./MarkupModal";
import { MatchModal } from "./MatchModal";
import { PoSModal } from "./PoSModal";
import { SettingTab } from "./SettingTab";
import myWorker from "./Workers/refreshDocs.worker";

const sentiment: (str: string) => Sentiment = require("wink-sentiment");

export default class NLPPlugin extends Plugin {
	settings: Settings;
	winkModel: WinkMethods;
	Docs: { [path: string]: Document } = {};
	worker: Worker;

	async onload() {
		console.log("loading");
		await this.loadSettings();
		this.addSettingTab(new SettingTab(this.app, this));

		this.winkModel = winkNLP(model);

		const { customEntityFilePath } = this.settings;
		if (customEntityFilePath !== "") {
			const customEntitiesStr = await this.app.vault.adapter.read(
				normalizePath(customEntityFilePath)
			);
			const customEntities: CustomEntityExample[] =
				JSON.parse(customEntitiesStr);
			this.winkModel.learnCustomEntities(customEntities);
		}

		[
			{ name: "Markup", modal: MarkupModal },
			{ name: "Match", modal: MatchModal },
			{ name: "PoS", modal: PoSModal },
		].forEach((modalType) => {
			this.addCommand({
				id: `open-${modalType.name}`,
				name: `Open ${modalType.name} Modal`,
				callback: () => {
					new modalType.modal(this.app, this).open();
				},
			});
		});

		this.addCommand({
			id: "refresh-docs",
			name: "Refresh Docs",
			callback: async () => {
				await this.refreshDocs();
			},
		});

		const addMarks = StateEffect.define(),
			filterMarks = StateEffect.define();

		const markField = StateField.define({
			create() {
				return Decoration.none;
			},
			// This is called whenever the editor updates—it computes the new set
			update(value, tr) {
				// Move the decorations to account for document changes
				value = value.map(tr.changes);
				for (let effect of tr.effects) {
					if (effect.is(addMarks))
						value = value.update({ add: effect.value, sort: true });
					else if (effect.is(filterMarks))
						value = value.update({ filter: effect.value });
				}
				return value;
			},
			// Indicate that this field provides a set of decorations
			provide: (f) => EditorView.decorations.from(f),
		});
		this.registerEditorExtension(markField);

		const classedMark = (...classes: string[]) =>
			Decoration.mark({ class: `${classes.join(" ")}` });

		this.addCommand({
			id: "highlight-parts-of-speech",
			name: "Highlight Parts of Speech",
			editorCallback: async (editor) => {
				let content = editor.getValue();
				const doc = compromise(content);
				const json = doc.json();

				const termsArr: {
					text: string;
					tags: string[];
					pre: string;
					post: string;
				}[] = json.map((sentence) => sentence.terms).flat();

				const removeBias = (tag: string) =>
					tag === "MaleName"
						? "MasculineName"
						: tag === "FemaleName"
						? "FeminineName"
						: tag;

				let currOffset = 0;
				const posMarks = [];
				termsArr.forEach((term) => {
					const { text, tags } = term;
					const start = content.indexOf(text, currOffset);
					currOffset = start + text.length;

					if (text.length)
						posMarks.push(
							classedMark(...tags.map(removeBias)).range(
								start,
								currOffset
							)
						);
				});

				(editor.cm as EditorView).dispatch({
					effects: addMarks.of(posMarks),
				});
			},
		});
		compromise.extend(require("compromise-sentences"));
		this.addCommand({
			id: "highlight-sentences",
			name: "Highlight Sentences",
			editorCallback: async (editor) => {
				let content = editor.getValue();
				const doc = compromise(content);

				let currOffset = 0;
				const sentenceMarks = doc
					.sentences()
					.json()
					.map((sentence) => {
						const { text } = sentence;
						const start = content.indexOf(
							text.slice(0, 5),
							currOffset
						);
						currOffset = start + text.length;

						return classedMark("Sentence").range(start, currOffset);
					});
				console.log({ sentenceMarks });
				(editor.cm as EditorView).dispatch({
					effects: addMarks.of(sentenceMarks),
				});
			},
		});

		compromise.extend(require("compromise-numbers"));
		compromise.extend(require("compromise-adjectives"));
		compromise.extend(require("compromise-dates"));

		for (const pos in TEXT_MANIPULATION_CMDS) {
			TEXT_MANIPULATION_CMDS[pos].forEach((fn) => {
				this.addCommand({
					id: `${pos} - ${fn}`,
					name: `${pos} - ${fn}`,
					editorCallback: async (ed) => {
						const sel = ed.getSelection();
						const compDoc = compromise(sel);
						compDoc[pos]()[fn]();
						const newSel = compDoc.text();
						ed.replaceSelection(newSel);
					},
				});
			});
		}

		ENTITIES.forEach((entity) => {
			this.addCommand({
				id: `entity - ${entity}`,
				name: `entity - ${entity}`,
				editorCallback: async (ed) => {
					const sel = ed.getSelection();
					const compDoc = compromise(sel);
					const entities = compDoc[entity]().out("array");
					await copy(entities.join(", "));
				},
			});
		});

		if (this.settings.refreshDocsOnLoad) {
			this.app.workspace.onLayoutReady(async () => {
				await this.refreshDocs();

				// this.worker = myWorker();
				// const workerStr = (async function () {
				// 	WORKER_STR
				// 	}
				// ).toString().slice(17);

				// this.worker = new Worker(
				// 	URL.createObjectURL(
				// 		new Blob([workerStr], { type: "text/javascript" })
				// 	)
				// );
				// console.log({ worker: this.worker });
				// this.worker.postMessage("test");
			});
		}
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async refreshDocs() {
		const notice = new Notice("Refreshing docs...");
		console.time("refreshDocs");
		try {
			for (const file of this.app.vault.getMarkdownFiles()) {
				this.Docs[file.path] = await this.getWinkDocFromFile(file);
			}
			notice.setMessage("Docs Refreshed");
		} catch (e) {
			console.log(e);
			notice.setMessage(
				"An error occured, check the console for more information."
			);
		}
		console.timeEnd("refreshDocs");
	}

	getNoStopBoW(doc: Document, type: "tokens" | "entities" = "tokens") {
		const { as, its } = this.winkModel;
		if (!doc) return {};
		return doc[type]()
			.filter(
				(item: ItemToken | ItemEntity) =>
					item.out(its.type) === "word" && !item.out(its.stopWordFlag)
			)
			.out(its.value, as.bow) as Bow;
	}
	getNoStopSet(
		doc: Document,
		type: "tokens" | "entities" = "tokens"
	): Set<string> {
		const { as, its } = this.winkModel;
		if (!doc) return new Set();
		return doc[type]()
			.filter(
				(item: ItemToken | ItemEntity) =>
					item.out(its.type) === "word" && !item.out(its.stopWordFlag)
			)
			.out(its.value, as.set) as Set<string>;
	}

	getAvgSentimentFromDoc(
		doc: Document,
		{ perSentence = false, normalised = true } = {}
	): number {
		const scoreType = normalised ? "normalizedScore" : "score";
		if (perSentence) {
			const sentences = doc.sentences().out();
			const sentiments = sentences.map((sentence) => sentiment(sentence));
			return (
				sentiments.reduce((a, b) => a + b[scoreType], 0) /
				sentences.length
			);
		} else {
			return sentiment(doc.out())[scoreType];
		}
	}

	async getWinkDocFromFile(
		file = this.app.workspace.getActiveFile()
	): Promise<Document | null> {
		if (!file) return null;
		const text = await this.app.vault.cachedRead(file);

		return this.winkModel.readDoc(text);
	}

	async getActiveFileContent(cached = true): Promise<string | null> {
		const currFile = this.app.workspace.getActiveFile();
		if (!(currFile instanceof TFile)) return null;
		if (cached) return await this.app.vault.cachedRead(currFile);
		else return await this.app.vault.read(currFile);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
