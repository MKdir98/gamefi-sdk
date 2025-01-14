import { Address, Builder, Cell, Contract, ContractProvider, Dictionary, SendMode, Sender, beginCell, contractAddress, toNano } from "@ton/core";
import { NoSenderError } from "../error";

export type NftItemParams = {
    owner: Address,
    individualContent: Cell | string,
};

export type SbtItemParams = NftItemParams & {
    authority?: Address,
};

export type SingleMintRequest<T> = {
    itemIndex: bigint,
    value?: bigint,
    itemParams: Cell | T,
};

export type SingleNftMintRequest = SingleMintRequest<NftItemParams>;

export type SingleSbtMintRequest = SingleMintRequest<SbtItemParams>;

export type MintRequest<T> = {
    queryId?: bigint,
    requestValue?: bigint,
} & SingleMintRequest<T>;

export type NftMintRequest = MintRequest<NftItemParams>;

export type SbtMintRequest = MintRequest<SbtItemParams>;

export type BatchMintRequest<T> = {
    queryId?: bigint,
    requestValue?: bigint,
    requests: SingleMintRequest<T>[],
};

export type NftBatchMintRequest = BatchMintRequest<NftItemParams>;

export type SbtBatchMintRequest = BatchMintRequest<SbtItemParams>;

function nftItemParamsToCell(params: NftItemParams): Cell {
    return beginCell()
        .storeAddress(params.owner)
        .storeRef(typeof params.individualContent === 'string' ? beginCell().storeStringTail(params.individualContent) : params.individualContent)
        .endCell();
}

function sbtItemParamsToCell(params: SbtItemParams): Cell {
    return beginCell()
        .storeAddress(params.owner)
        .storeRef(typeof params.individualContent === 'string' ? beginCell().storeStringTail(params.individualContent) : params.individualContent)
        .storeAddress(params.authority)
        .endCell();
}

function storeSingleMintRequest<T>(request: SingleMintRequest<T>, storeParams: (params: T) => Cell): (builder: Builder) => void {
    return (builder: Builder) => {
        builder
            .storeCoins(request.value ?? toNano('0.03'))
            .storeRef(request.itemParams instanceof Cell ? request.itemParams : storeParams(request.itemParams))
    };
}

export abstract class NftCollectionBase<T> implements Contract {
    constructor(public readonly address: Address, public sender?: Sender, public readonly init?: { code: Cell, data: Cell }) {}

    async getItemAddress(provider: ContractProvider, index: bigint) {
        return (await provider.get('get_nft_address_by_index', [{ type: 'int', value: index }])).stack.readAddress();
    }

    abstract paramsToCell(params: T): Cell

    mintMessage(request: MintRequest<T>): Cell {
        return beginCell()
            .storeUint(1, 32)
            .storeUint(request.queryId ?? 0, 64)
            .storeUint(request.itemIndex, 64)
            .storeWritable(storeSingleMintRequest(request, this.paramsToCell))
            .endCell();
    }

    batchMintMessage(request: BatchMintRequest<T>): Cell {
        const dict: Dictionary<bigint, SingleMintRequest<T>> = Dictionary.empty(Dictionary.Keys.BigUint(64), {
            serialize: (r, b) => storeSingleMintRequest(r, this.paramsToCell)(b),
            parse: () => { throw new Error('Unsupported'); },
        });
        for (const r of request.requests) {
            if (dict.has(r.itemIndex)) {
                throw new Error('Duplicate items');
            }
            dict.set(r.itemIndex, r);
        }

        return beginCell()
            .storeUint(2, 32)
            .storeUint(request.queryId ?? 0, 64)
            .storeRef(beginCell().storeDictDirect(dict))
            .endCell();
    }

    async sendMint(provider: ContractProvider, request: MintRequest<T>) {
        if (this.sender === undefined) {
            throw new NoSenderError();
        }
        await provider.internal(this.sender, {
            value: request.requestValue ?? toNano('0.05'),
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: this.mintMessage(request),
        });
    }

    async sendBatchMint(provider: ContractProvider, request: BatchMintRequest<T>) {
        if (this.sender === undefined) {
            throw new NoSenderError();
        }
        await provider.internal(this.sender, {
            value: request.requestValue ?? toNano('0.05'),
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: this.batchMintMessage(request),
        });
    }

    async sendDeploy(provider: ContractProvider, value: bigint) {
        if (this.sender === undefined) {
            throw new NoSenderError();
        }
        await provider.internal(this.sender, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            bounce: true,
        })
    }

    async getData(provider: ContractProvider) {
        const ret = await provider.get('get_collection_data', []);
        return {
            nextItemIndex: ret.stack.readBigNumber(),
            content: ret.stack.readCell(),
            owner: ret.stack.readAddressOpt(),
        };
    }
}

export class NftCollection extends NftCollectionBase<NftItemParams> {
    static create(params: {
        admin: Address,
        content: Cell,
        royalty?: {
            numerator: number,
            denominator: number,
            recipient?: Address,
        },
    }, sender?: Sender) {
        const data = beginCell()
            .storeAddress(params.admin)
            .storeUint(0, 64)
            .storeRef(params.content)
            .storeRef(itemCode)
            .storeRef(beginCell()
                .storeUint(params.royalty?.numerator ?? 0, 16)
                .storeUint(params.royalty?.denominator ?? 1, 16)
                .storeAddress(params.royalty?.recipient ?? params.admin))
            .endCell();
        const init = { data, code: collectionCode };
        return new NftCollection(contractAddress(0, init), sender, init);
    }

    static open(address: Address, sender?: Sender) {
        return new NftCollection(address, sender);
    }
    
    paramsToCell(params: NftItemParams): Cell {
        return nftItemParamsToCell(params);
    }
}

export class SbtCollection extends NftCollectionBase<SbtItemParams> {
    static create(params: {
        admin: Address,
        content: Cell,
        royalty?: {
            numerator: number,
            denominator: number,
            recipient?: Address,
        },
    }, sender?: Sender) {
        const data = beginCell()
            .storeAddress(params.admin)
            .storeUint(0, 64)
            .storeRef(params.content)
            .storeRef(sbtItemCode)
            .storeRef(beginCell()
                .storeUint(params.royalty?.numerator ?? 0, 16)
                .storeUint(params.royalty?.denominator ?? 1, 16)
                .storeAddress(params.royalty?.recipient ?? params.admin))
            .endCell();
        const init = { data, code: collectionCode };
        return new SbtCollection(contractAddress(0, init), sender, init);
    }

    static open(address: Address, sender?: Sender) {
        return new SbtCollection(address, sender);
    }
    
    paramsToCell(params: SbtItemParams): Cell {
        return sbtItemParamsToCell(params);
    }
}

const collectionCode = Cell.fromBase64('te6cckECEwEAAf4AART/APSkE/S88sgLAQIBYgIDAgLNBAUCASANDgPr0QY4BIrfAA6GmBgLjYSK3wfSAYAOmP6Z/2omh9IGmf6mpqGEEINJ6cqClAXUcUG6+CgOhBCFRlgFa4QAhkZYKoAueLEn0BCmW1CeWP5Z+A54tkwCB9gHAbKLnjgvlwyJLgAPGBEuABcYEZAmAB8YEvgsIH+XhAYHCAIBIAkKAGA1AtM/UxO78uGSUxO6AfoA1DAoEDRZ8AaOEgGkQ0PIUAXPFhPLP8zMzMntVJJfBeIApjVwA9QwjjeAQPSWb6UgjikGpCCBAPq+k/LBj96BAZMhoFMlu/L0AvoA1DAiVEsw8AYjupMCpALeBJJsIeKz5jAyUERDE8hQBc8WE8s/zMzMye1UACgB+kAwQUTIUAXPFhPLP8zMzMntVAIBIAsMAD1FrwBHAh8AV3gBjIywVYzxZQBPoCE8trEszMyXH7AIAC0AcjLP/gozxbJcCDIywET9AD0AMsAyYAAbPkAdMjLAhLKB8v/ydCACASAPEAAlvILfaiaH0gaZ/qamoYLehqGCxABDuLXTHtRND6QNM/1NTUMBAkXwTQ1DHUMNBxyMsHAc8WzMmAIBIBESAC+12v2omh9IGmf6mpqGDYg6GmH6Yf9IBhAALbT0faiaH0gaZ/qamoYCi+CeAI4APgCwWurO9Q==');
const itemCode = Cell.fromBase64('te6cckECDgEAAdwAART/APSkE/S88sgLAQIBYgIDAgLOBAUACaEfn+AFAgEgBgcCASAMDQLPDIhxwCSXwPg0NMDAXGwkl8D4PpA+kAx+gAxcdch+gAx+gAwc6m0APACBLOOFDBsIjRSMscF8uGVAfpA1DAQI/AD4AbTH9M/ghBfzD0UUjC64wIwNDQ1NYIQL8smohK64wJfBIQP8vCAICQARPpEMHC68uFNgAqwyEDdeMkATUTXHBfLhkfpAIfAB+kDSADH6ACDXScIA8uLEggr68IAboSGUUxWgod4i1wsBwwAgkgahkTbiIML/8uGSIZQQKjdb4w0CkzAyNOMNVQLwAwoLAHJwghCLdxc1BcjL/1AEzxYQJIBAcIAQyMsFUAfPFlAF+gIVy2oSyx/LPyJus5RYzxcBkTLiAckB+wAAfIIQBRONkchQCc8WUAvPFnEkSRRURqBwgBDIywVQB88WUAX6AhXLahLLH8s/Im6zlFjPFwGRMuIByQH7ABBHAGom8AGCENUydtsQN0QAbXFwgBDIywVQB88WUAX6AhXLahLLH8s/Im6zlFjPFwGRMuIByQH7AAA7O1E0NM/+kAg10nCAJp/AfpA1DAQJBAj4DBwWW1tgAB0A8jLP1jPFgHPFszJ7VSAhpPNg');
const sbtItemCode = Cell.fromBase64('te6cckECEwEAAzsAART/APSkE/S88sgLAQIBYgIDAgLOBAUCASAPEAS9RsIiDHAJFb4AHQ0wP6QDDwAvhCs44cMfhDAccF8uGV+kAB+GTUAfhm+kAw+GVw+GfwA+AC0x8CcbDjAgHTP4IQ0MO/6lIwuuMCghAE3tFIUjC64wIwghAvyyaiUiC6gGBwgJAgEgDQ4AlDAx0x+CEAUkx64Suo450z8wgBD4RHCCEMGOhtJVA22AQAPIyx8Syz8hbrOTAc8XkTHiyXEFyMsFUATPFlj6AhPLaszJAfsAkTDiAMJsEvpA1NMAMPhH+EHIy/9QBs8W+ETPFhLMFMs/UjDLAAPDAJb4RlADzALegBB4sXCCEA3WB+NANRSAQAPIyx8Syz8hbrOTAc8XkTHiyXEFyMsFUATPFlj6AhPLaszJAfsAAMYy+ERQA8cF8uGR+kDU0wAw+Ef4QcjL//hEzxYTzBLLP1IQywABwwCU+EYBzN6AEHixcIIQBSTHrkBVA4BAA8jLHxLLPyFus5MBzxeRMeLJcQXIywVQBM8WWPoCE8tqzMkB+wAD+o5AMfhByMv/+EPPFoAQcIIQi3cXNUAVUEQDgEADyMsfEss/IW6zkwHPF5Ex4slxBcjLBVAEzxZY+gITy2rMyQH7AOCCEB8EU3pSILrjAoIQb4n141Iguo4WW/hFAccF8uGR+EfAAPLhk/gj+GfwA+CCENE207NSILrjAjAxCgsMAJIx+EQixwXy4ZGAEHCCENUydtsQJFUCbYMGA8jLHxLLPyFus5MBzxeRMeLJcQXIywVQBM8WWPoCE8tqzMkB+wCLAvhkiwL4ZfADAI4x+EQixwXy4ZGCCvrwgHD7AoAQcIIQ1TJ22xAkVQJtgwYDyMsfEss/IW6zkwHPF5Ex4slxBcjLBVAEzxZY+gITy2rMyQH7AAAgghBfzD0UupPywZ3ehA/y8ABhO1E0NM/Afhh+kAB+GNw+GIg10nCAI4Wf/hi+kAB+GTUAfhm+kAB+GXTPzD4Z5Ew4oAA3PhH+Eb4QcjLP/hDzxb4RM8WzPhFzxbLP8ntVIAIBWBESAB28fn+AF8IXwg/CH8InwjQADbVjHgBfCLAADbewfgBfCPAtMqVw');
