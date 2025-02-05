import { Request, Response } from "express";
import { config } from "dotenv";
import Transaction from "../models/transactionmodel";
import {
  airtimeValidation,
  options,
  validBankTransfer,
} from "../utils/signupValidation";
import User from "../models/userModel";
import Bcrypt from "bcryptjs";
import axios from "axios";
import { TELCOS, calculateBalance } from "../utils/utils";
import {
  buyAirtimeFromBloc,
  NetworkItem,
  DataPlan,
  PlanReturn,
  fetchDataPlan,
  buyDataFromBloc,
} from "../utils/bloc";

config();
const ps_secret = process.env.PAYSTACK_SECRET;
const bloc_secret = process.env.BLOCHQ_TOKEN;

export async function buyAirtime(req: Request, res: Response) {
  const userId = req.user;
  const { error } = airtimeValidation.validate(req.body, options);
  if (error) {
    console.error("form details wrong");
    return res.status(400).json({
      message: "Bad request",
      error: error.message,
    });
  }

  const user = await User.findById(userId);
  if (!user) {
    console.error("user not found");
    return res.status(404).json({
      message: "User not found",
    });
  }

  const { amount, phoneNumber, network, transactionPin } = req.body;
  const amountInKobo = amount * 100;
  try {
    const userBalance = await calculateBalance(userId);
    user.balance = userBalance;
    await user.save();
    if (
      user.transactionPin !== transactionPin &&
      !Bcrypt.compareSync(transactionPin, user.transactionPin as string)
    ) {
      console.error("invalid pin");
      return res.status(403).json({
        message: "Invalid transaction pin",
      });
    }
    if (user.balance < amountInKobo) {
      console.error("insufficient funds");
      return res.status(400).json({
        message: "purchase failed",
        error: "Insufficient balance",
      });
    }

    const appState = "testing";

    if (appState === "testing") {
      const dudTransaction = await Transaction.create({
        amount: amountInKobo,
        phoneNumber,
        network,
        userId,
        transactionType: "airtime",
        credit: false,
      });

      return res.json({
        message: "Purchase successful",
        data: dudTransaction,
      });
    }

    //call the airtime api (blochq)
    const response = await buyAirtimeFromBloc(
      amountInKobo,
      phoneNumber,
      network
    );

    if (!response.success) {
      console.error("purchase failed from bloc");
      console.error(response);
      return res.status(400).json(response);
    }

    const { status, reference } = response.data;

    if (status !== "successful") {
      console.error("Airtime purchase not successful");
      return res.status(400).json({
        message: "Airtime purchase not successful",
        data: reference,
      });
    }
    const transaction = new Transaction({
      amount: amountInKobo,
      phoneNumber,
      network,
      userId,
      transactionType: "airtime",
      credit: false,
      reference,
      status,
    });
    await transaction.save();

    user.balance -= amount;
    user.save();
    res.json({
      message: "successfully purchased airtime",
      data: transaction,
    });
  } catch (error: any) {
    console.log(error);
    res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
}
export async function getBalance(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        message: "No token found",
        error: "Unauthorised",
      });
    }
    const userId = req.user;

    const balance = await calculateBalance(userId);

    return res.json({
      message: "User balance",
      data: balance,
    });
  } catch (error: any) {
    console.error("Error calculating balance:", error);
    res
      .status(500)
      .json({ message: "Error calculating balance", error: error.message });
  }
}

export async function fundAccount(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        message: "No token provided",
        error: "Unauthorised",
      });
    }
    const user = await User.findById(req.user);

    if (!user) {
      return res.status(404).json({
        message: "Cannot process transaction",
        error: "User not found",
      });
    }

    const { reference } = req.body;
    const Authorization = `Bearer ${ps_secret}`;

    const processedFund = await Transaction.findOne({ reference });
    if (processedFund) {
      return res.status(409).json({
        message: "Stale transaction",
        error: "This transaction has been processed already",
      });
    }
    axios
      .get(`https://api.paystack.co/transaction/verify/${reference}`, {
        headers: {
          Authorization,
        },
      })
      .then(async (response) => {
        if (response.data.status) {
          const creditAmount = response.data.data.amount;
          const funds = new Transaction({
            amount: creditAmount,
            reference,
            bankName: "Decagon",
            accountName: "Monie-Paddy",
            credit: true,
            userId: req.user,
            transactionType: "fund wallet",
          });
          funds.save();
          return res.json({
            message: "Success",
            data: creditAmount,
          });
        }
      })
      .catch((error) => {
        console.error(`Error funding ${user.email} wallet:`, error.message);
        return res.status(500).json({
          message: "Transaction failed",
          error: "Could not confirm transaction",
        });
      });
  } catch (err: any) {
    console.error("Internal server error: ", err.message);
    return res.status(500).json({
      message: err.message,
      error: err,
    });
  }
}

export async function bankTransfer(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        message: "No token provided",
        error: "Unauthorised",
      });
    }

    const user = await User.findById(req.user);

    if (!user) {
      return res.status(404).json({
        message: "Cannot process transaction",
        error: "User not found",
      });
    }

    const { error } = validBankTransfer.validate(req.body);
    if (error) {
      return res.status(400).json({
        message: "Transaction failed",
        error: error.message,
      });
    }
    const { amount, bankName, accountName, accountNumber, note, pin } =
      req.body;
    if (!user.transactionPin) {
      return res.status(403).json({
        message: "Transaction failed",
        error: "Invalid credentials",
      });
    }
    const validPin = Bcrypt.compareSync(pin, user.transactionPin);
    if (!validPin) {
      return res.status(403).json({
        message: "Transaction failed",
        error: "Invalid credentials",
      });
    }

    const balance = await calculateBalance(req.user);

    if (balance < amount) {
      return res.status(409).json({
        message: "Transaction failed",
        error: "Insufficient funds",
      });
    }

    const transfer = await Transaction.create({
      userId: req.user,
      amount,
      accountName,
      accountNumber,
      bankName,
      transactionType: "transfer",
      credit: false,
      note,
    });

    return res.json({
      message: "Transfer successful",
      data: transfer,
    });
  } catch (err: any) {
    console.error("Internal server error: ", err.message);
    return res.status(500).json({
      message: "Internal server error",
      error: err.message,
    });
  }
}
export async function getTransactions(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        message: "No token provided",
        error: "Unauthorised",
      });
    }
    const { search, filter } = req.query;
    let query: any = { userId: req.user };
    if (search) {
      query.$or = [
        { transactionType: { $regex: search as string, $options: "i" } },
        { accountName: { $regex: search as string, $options: "i" } },
        { accountNumber: { $regex: search as string, $options: "i" } },
        { bankName: { $regex: search as string, $options: "i" } },
        { phoneNumber: { $regex: search as string, $options: "i" } },
        { network: { $regex: search as string, $options: "i" } },
        { dataPlan: { $regex: search as string, $options: "i" } },
        { electricityMeterNo: { $regex: search as string, $options: "i" } },
        { note: { $regex: search as string, $options: "i" } },
      ];
    }
    if (filter === "sucessfully" || filter === "failed") {
      query.status = filter;
    }
    if (filter === "true" || filter === "false") {
      query.credit = filter;
    }
    if (filter === "all") {
      query = {};
    }
    // console.log('Query:', query);
    const transactions = await Transaction.find(query);
    console.log("Transactions:", transactions);
    return res.json({
      message: "Transactions",
      data: transactions,
    });
  } catch (err: any) {
    console.error("Internal server error: ", err.message);
    return res.status(500).json({
      message: "Internal server error",
      error: err.message,
    });
  }
}

export async function getNetwork(req: Request, res: Response) {
  try {
    const Authorization = `Bearer ${bloc_secret}`;
    axios
      .get("https://api.blochq.io/v1/bills/operators?bill=telco", {
        headers: {
          Authorization,
        },
      })
      .then((response) => {
        const { success } = response.data;
        if (success) {
          const summary = response.data.data.map((item: NetworkItem) => ({
            name: item.name,
            id: item.id,
          }));
          return res.json({
            message: "Networks",
            data: summary,
          });
        } else {
          return res.status(502).json({
            message: "Networks unavailable",
            error: "Could not fetch networks",
          });
        }
      })
      .catch((error) => {
        console.error(error);
        return res.status(502).json({
          message: "Networks unavailable",
          error: "Could not fetch networks",
        });
      });
  } catch (err: any) {
    console.error("Internal server error: ", err.message);
    return res.status(500).json({
      message: "Internal server error",
      error: err.message,
    });
  }
}

export async function getDataPlans(req: Request, res: Response) {
  try {
    const network = req.query.network as string;
    const id = TELCOS.find(
      (telco) => telco.name.toLowerCase() === network.toLowerCase()
    )?.id;
    console.log(id);
    if (!id) {
      return res.status(400).json({
        message: "Bad request",
        error: "Network id not provided",
      });
    }

    const Authorization = `Bearer ${bloc_secret}`;

    axios
      .get(
        `https://api.blochq.io/v1/bills/operators/${id}/products?bill=telco`,
        {
          headers: {
            Authorization,
          },
        }
      )
      .then((response) => {
        const { success } = response.data;
        if (success) {
          const plans: PlanReturn[] = [];
          response.data.data.forEach((item: DataPlan) => {
            if (item.fee_type === "FIXED") {
              const formatFee = item.meta.fee.split(".")[0];
              item.meta.fee = formatFee;
              plans.push({ id: item.id, meta: item.meta });
            }
          });
          return res.json({
            message: "Data Plans",
            data: plans,
          });
        } else {
          return res.status(502).json({
            message: "Data Plans unavailable",
            error: "Could not fetch data plans",
          });
        }
      })
      .catch((error) => {
        console.error(error);
        return res.status(502).json({
          message: "Data Plans unavailable",
          error: "Could not fetch data plans",
        });
      });
  } catch (err: any) {
    console.error("Internal server error: ", err.message);
    return res.status(500).json({
      message: "Internal server error",
      error: err.message,
    });
  }
}

export async function buyDataPlans(req: Request, res: Response) {
  const userId = req.user;

  const user = await User.findById(userId);
  if (!user) {
    console.error("user not found");
    return res.status(404).json({
      message: "User not found",
    });
  }

  const { dataPlanId, phoneNumber, network, transactionPin } = req.body;
  const dataPlan = await fetchDataPlan(network, dataPlanId);
  console.log(dataPlan);

  if (!dataPlan) {
    console.error(`Error getting plan ${dataPlan.error}`);
    return res.status(502).json({
      message: `Error getting plan`,
    });
  }

  if (dataPlan.error) {
    console.error(`Error getting plan ${dataPlan.error}`);
    return res.status(502).json({
      message: `Error getting plan`,
    });
  }

  const amount = Number(dataPlan.meta.fee);
  const amountInKobo = amount * 100;
  try {
    const userBalance = await calculateBalance(userId);
    user.balance = userBalance;
    await user.save();
    if (
      user.transactionPin !== transactionPin &&
      !Bcrypt.compareSync(transactionPin, user.transactionPin as string)
    ) {
      console.error("invalid pin");
      return res.status(403).json({
        message: "Invalid transaction pin",
      });
    }
    if (user.balance < amountInKobo) {
      console.error("insufficient funds");
      return res.status(400).json({
        message: "purchase failed",
        error: "Insufficient balance",
      });
    }

    const appState = "testing";

    if (appState === "testing") {
      const dudTransaction = await Transaction.create({
        amount: amountInKobo,
        phoneNumber,
        network,
        userId,
        transactionType: "data",
        credit: false,
      });

      return res.json({
        message: "Purchase successful",
        data: dudTransaction,
      });
    }

    //call the data api (blochq)
    const response = await buyDataFromBloc(dataPlanId, phoneNumber, network);

    if (!response.success) {
      console.error("purchase failed from bloc");
      console.error(response);
      return res.status(400).json(response);
    }

    const { status, reference } = response.data;

    if (status !== "successful") {
      console.error("Airtime purchase not successful");
      return res.status(400).json({
        message: "Airtime purchase not successful",
        data: reference,
      });
    }
    const transaction = new Transaction({
      amount: amountInKobo,
      phoneNumber,
      network,
      userId,
      transactionType: "airtime",
      credit: false,
      reference,
      status,
    });
    await transaction.save();

    user.balance -= amount;
    user.save();
    res.json({
      message: "successfully purchased airtime",
      data: transaction,
    });
  } catch (error: any) {
    console.log(error);
    res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
}
